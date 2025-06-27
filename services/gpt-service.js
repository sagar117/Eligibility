const fs = require('fs');
const path = require('path');
require('colors');

const { EventEmitter } = require('events');
const OpenAI = require('openai');
const tools = require('../functions/function-manifest');

/* ------------------------------------------------------------------
   Load function-call helpers declared in function‑manifest.json
------------------------------------------------------------------ */
const availableFunctions = {};
tools.forEach((tool) => {
  const functionName = tool.function.name;
  availableFunctions[functionName] = require(`../functions/${functionName}`);
});

/* ==================================================================
   GPT SERVICE – JENNY (Benefits Verification)  
   • Captures full transcript  
   • Emits partial chunks for TTS  
   • Triggers 'endCall' when Jenny says GOODBYE  
================================================================== */
class GptService extends EventEmitter {
  constructor({ memberId, dob, dlNumber }) {
    super();
    this.openai = new OpenAI();

    /* --------------------------------------------------------------
       Prompt Template (external file with {{mustache}} tokens)
    -------------------------------------------------------------- */
    const template = fs.readFileSync(
      path.join(__dirname, '../prompts/cc.txt'),
      'utf8'
    );

    const systemPrompt = template
      .replace('{{memberId}}', memberId)
      .replace('{{dob}}', dob)
      .replace('{{dlNumber}}', dlNumber);

    /* --------------------------------------------------------------
       Chat context & transcript store
    -------------------------------------------------------------- */
    this.userContext = [
      { role: 'system', content: systemPrompt },
      {
        role: 'assistant',
        content:
          'Hi, this is Jenny from <CLINIC_NAME>. I’m calling to verify benefits for a patient — could you help me with that?',
      },
    ];

    this.partialResponseIndex = 0;
    this.transcript = []; // ← full call transcript
  }

  /* --------------------------------------------------------------
     Helper: append Twilio call SID (for transfer scenarios)
  -------------------------------------------------------------- */
  setCallSid(callSid) {
    this.userContext.push({ role: 'system', content: `callSid: ${callSid}` });
  }

  /* --------------------------------------------------------------
     Validate/parse function‑call arguments
  -------------------------------------------------------------- */
  validateFunctionArgs(args) {
    try {
      return JSON.parse(args);
    } catch (error) {
      // Sometimes args arrive concatenated twice – try to salvage
      if (args.indexOf('{') !== args.lastIndexOf('{')) {
        return JSON.parse(args.substring(args.indexOf('{'), args.indexOf('}') + 1));
      }
      console.log('Function args parse error:', error);
      return {};
    }
  }

  /* --------------------------------------------------------------
     Update chat history (OpenAI messages array)
  -------------------------------------------------------------- */
  updateUserContext(name, role, text) {
    if (name !== 'user') {
      this.userContext.push({ role, name, content: text });
    } else {
      this.userContext.push({ role, content: text });
    }
  }

  /* --------------------------------------------------------------
     Public getter for the full transcript
  -------------------------------------------------------------- */
  getTranscript() {
    return this.transcript;
  }

  /* --------------------------------------------------------------
     Core streaming completion handler
  -------------------------------------------------------------- */
  async completion(text, interactionCount, role = 'user', name = 'user') {
    // ---------- Store user message ----------
    this.updateUserContext(name, role, text);
    this.transcript.push({ speaker: role === 'user' ? 'user' : name, text });

    // ---------- Call OpenAI (streaming) ----------
    const stream = await this.openai.chat.completions.create({
      model: 'gpt-4-1106-preview',
      messages: this.userContext,
      tools,
      stream: true,
    });

    let completeResponse = '';
    let partialResponse = '';
    let functionName = '';
    let functionArgs = '';

    const collectToolInfo = (deltas) => {
      const name = deltas.tool_calls?.[0]?.function?.name || '';
      if (name) functionName = name;
      const args = deltas.tool_calls?.[0]?.function?.arguments || '';
      if (args) functionArgs += args;
    };

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      const deltas = chunk.choices[0].delta;
      const finishReason = chunk.choices[0].finish_reason;

      if (deltas.tool_calls) collectToolInfo(deltas);

      /* ---------- End of tool call block ---------- */
      if (finishReason === 'tool_calls') {
        const fn = availableFunctions[functionName];
        const validated = this.validateFunctionArgs(functionArgs);

        // Pre‑function message (say) to caller
        const say = tools.find(t => t.function.name === functionName).function.say;
        this.emit('gptreply', { partialResponseIndex: null, partialResponse: say }, interactionCount);

        const fnResponse = await fn(validated);
        this.updateUserContext(functionName, 'function', fnResponse);
        await this.completion(fnResponse, interactionCount, 'function', functionName);
        return; // further streaming handled in recursive call
      }

      /* ---------- Normal assistant streaming ---------- */
      completeResponse += content;
      partialResponse += content;

      if (content.trim().slice(-1) === '•' || finishReason === 'stop') {
        this.emit('gptreply', {
          partialResponseIndex: this.partialResponseIndex,
          partialResponse,
        }, interactionCount);

        if (completeResponse.trim()) {
          this.transcript.push({ speaker: 'assistant', text: completeResponse.trim() });
        }

        if (completeResponse.toUpperCase().includes('GOODBYE')) {
          this.emit('endCall');
        }

        this.partialResponseIndex += 1;
        partialResponse = '';
      }
    }

    // Store assistant final message in chat context
    this.userContext.push({ role: 'assistant', content: completeResponse });
    console.log(`GPT -> user context length: ${this.userContext.length}`.green);
  }
}

module.exports = { GptService };
