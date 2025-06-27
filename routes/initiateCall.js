const express = require('express');
const router = express.Router();
const twilio = require('twilio');

router.post('/initiate-call', async (req, res) => {
  const {
    to,
    from,
    twilioAccountSid,
    twilioAuthToken,
    voiceUrl
  } = req.body;

  if (!to || !from || !twilioAccountSid || !twilioAuthToken || !voiceUrl) {
    return res.status(400).json({ error: 'Missing required parameters.' });
  }

  try {
    const client = twilio(twilioAccountSid, twilioAuthToken);

    const call = await client.calls.create({
      to,
      from,
      url: voiceUrl,
    });

    res.status(200).json({
      message: 'Call initiated successfully',
      callSid: call.sid
    });
  } catch (error) {
    console.error('Twilio call error:', error);
    res.status(500).json({ error: 'Failed to initiate call', details: error.message });
  }
});

module.exports = router;
