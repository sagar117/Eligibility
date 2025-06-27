require('colors');
const fs = require('fs');
const path = require('path');

const EventEmitter = require('events');
const OpenAI = require('openai');
const tools = require('../functions/function-manifest');

const availableFunctions = {};
tools.forEach((tool) => {
  let functionName = tool.function.name;
  availableFunctions[functionName] = require(`../functions/${functionName}`);
});

class GptService extends EventEmitter {
  constructor({ memberId, dob, dlNumber }) {
    super();
    this.openai = new OpenAI();

        // Load prompt template from external file
    const promptTemplate = fs.readFileSync(
      path.join(__dirname, '../prompts/jenny-benefits.txt'),
      'utf8'
    );

// Inject dynamic values
    const prompt = promptTemplate
      .replace('{{memberId}}', memberId)
      .replace('{{dob}}', dob)
      .replace('{{dlNumber}}', dlNumber);


    // Jenny the front desk assistant verifying benefits
    this.userContext = [
      {
        role: 'system',
        content: prompt
      },
      {
        role: 'assistant',
        content: 'Hi, this is Jenny from <CLINIC_NAME>. I’m calling to verify benefits for a patient — could you help me with that?'
      }
    ];

    this.partialResponseIndex = 0;
  }

  setCallSid(callSid) {
    this.userContext.push({ role: 'system', content: `callSid: ${callSid}` });
  }

  validateFunctionArgs(args) {
    try {
      return JSON.parse(args);
    } catch (error) {
      console.log('Warning: Double function arguments returned by OpenAI:', args);
      if (args.indexOf('{') != args.lastIndexOf('{')) {
        return JSON.parse(args.substring(args.indexOf(''), args.indexOf('}') + 1));
      }
    }
  }

  updateUserContext(name, role, text) {
    if (name !== 'user') {
      this.userContext.push({ role, name, content: text });
    } else {
      this.userContext.push({ role, content: text });
    }
  }

  async completion(text, interactionCount, role = 'user', name = 'user') {
    this.updateUserContext(name, role, text);
    const stream = await this.openai.chat.completions.create({
      model: 'gpt-4-1106-preview',
      messages: this.userContext,
      tools: tools,
      stream: true,
    });

    let completeResponse = '';
    let partialResponse = '';
    let functionName = '';
    let functionArgs = '';
    let finishReason = '';

    function collectToolInformation(deltas) {
      let name = deltas.tool_calls[0]?.function?.name || '';
      if (name) functionName = name;
      let args = deltas.tool_calls[0]?.function?.arguments || '';
      if (args) functionArgs += args;
    }

    for await (const chunk of stream) {
      let content = chunk.choices[0]?.delta?.content || '';
      let deltas = chunk.choices[0].delta;
      finishReason = chunk.choices[0].finish_reason;

      if (deltas.tool_calls) {
        collectToolInformation(deltas);
      }

      if (finishReason === 'tool_calls') {
        const functionToCall = availableFunctions[functionName];
        const validatedArgs = this.validateFunctionArgs(functionArgs);

        const toolData = tools.find(tool => tool.function.name === functionName);
        const say = toolData.function.say;

        this.emit('gptreply', {
          partialResponseIndex: null,
          partialResponse: say
        }, interactionCount);

        let functionResponse = await functionToCall(validatedArgs);
        this.updateUserContext(functionName, 'function', functionResponse);
        await this.completion(functionResponse, interactionCount, 'function', functionName);
      } else {
        completeResponse += content;
        partialResponse += content;

        if (content.trim().slice(-1) === '•' || finishReason === 'stop') {
          const gptReply = {
            partialResponseIndex: this.partialResponseIndex,
            partialResponse
          };

          // Emit TTS-ready response
          this.emit('gptreply', gptReply, interactionCount);

          // ✅ NEW: Emit signal if GPT says GOODBYE
          if (completeResponse.trim().toUpperCase().includes("GOODBYE")) {
            this.emit('endCall'); // your app.js should listen to this and hang up
          }

          this.partialResponseIndex++;
          partialResponse = '';
        }
      }
    }

    this.userContext.push({ role: 'assistant', content: completeResponse });
    console.log(`GPT -> user context length: ${this.userContext.length}`.green);
  }
}

module.exports = { GptService };
