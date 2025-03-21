const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// In-memory conversation storage
const conversations = {};

// Main chat endpoint
app.post('/api/verify', async (req, res) => {
  try {
    console.log('Received request:', req.body);
    const { message, conversationId = 'default' } = req.body;
    
    if (!message) {
      return res.status(400).json({ 
        error: 'No message provided',
        response: "Please send a message to get a response."
      });
    }
    
    // Store conversation
    if (!conversations[conversationId]) {
      conversations[conversationId] = [];
    }
    conversations[conversationId].push({ role: 'user', content: message });
    
    // Generate response based on message content
    let response = '';
    
    // Handle different message types with hardcoded responses
    const lowerMessage = message.toLowerCase().trim();
    
    if (/^(hello|hi|hey|greetings)/i.test(lowerMessage)) {
      response = "Hello! I'm your AI assistant. How can I help you today?";
    }
    else if (/what('s| is)? up/i.test(lowerMessage)) {
      response = "Not much! I'm here and ready to chat. What would you like to talk about today?";
    }
    else if (lowerMessage.includes('news')) {
      response = "I'd be happy to discuss current news topics. Is there a specific subject you're interested in?";
    }
    else if (lowerMessage.includes('weather')) {
      response = "While I can't check the current weather, I can discuss weather patterns and climate topics. What specifically about weather interests you?";
    }
    else if (lowerMessage.includes('help')) {
      response = "I'm here to help! You can ask me about various topics, request information, or just chat. What would you like to know?";
    }
    else if (lowerMessage.includes('?')) {
      response = "That's an interesting question! I'd be happy to discuss this topic with you. What aspects are you most curious about?";
    }
    else {
      response = "Thanks for your message! I'm your AI chat assistant. Is there something specific you'd like to talk about or learn about today?";
    }
    
    // Store response
    conversations[conversationId].push({ role: 'assistant', content: response });
    
    console.log('Sending response:', response);
    
    // Send response
    res.json({
      response,
      conversationId,
      sources: [] // No sources in the simple version
    });
    
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ 
      error: true, 
      response: "Hello! I'm your AI assistant. How can I help you today?" // Always give a useful response even on error
    });
  }
});

// Status endpoint
app.get('/api/status', (req, res) => {
  res.json({ status: 'online', conversationCount: Object.keys(conversations).length });
});

// Root endpoint
app.get('/', (req, res) => {
  res.send('Chat server is running! Send POST requests to /api/verify to chat.');
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Ultra Simple Chat Server running on port ${PORT}`);
}); 