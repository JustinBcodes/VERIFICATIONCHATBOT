const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize conversation memory (simple in-memory store)
const conversations = {};

// Simple news API endpoint
const NEWS_API_BASE_URL = 'https://newsapi.org/v2';

// Validate API key
if (!process.env.NEWS_API_KEY) {
  console.error('⚠️ NEWS_API_KEY is missing in .env file');
  process.exit(1);
}

// Main chat endpoint
app.post('/api/verify', async (req, res) => {
  try {
    const { message, conversationId = 'default' } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'No message provided' });
    }
    
    console.log(`Received message: "${message}"`);
    
    // Store conversation
    if (!conversations[conversationId]) {
      conversations[conversationId] = [];
    }
    conversations[conversationId].push({ role: 'user', content: message });
    
    // Handle greetings
    if (/^(hello|hi|hey|what's up|whats up|sup|yo|greetings)$/i.test(message.trim())) {
      const response = "Hello! I'm your news verification assistant. What topic would you like to know about today?";
      conversations[conversationId].push({ role: 'assistant', content: response });
      return res.json({ response, conversationId, sources: [] });
    }
    
    // Check if it's a news query
    const isNewsQuery = /news|latest|update|headlines|what.*happening|current events/i.test(message);
    
    let articles = [];
    let response = "";
    
    if (isNewsQuery) {
      try {
        // Fetch news
        const newsResponse = await axios.get(`${NEWS_API_BASE_URL}/top-headlines`, {
          params: {
            q: message.replace(/news|latest|update|headlines|what.*happening|current events/ig, '').trim(),
            language: 'en',
            pageSize: 5,
            apiKey: process.env.NEWS_API_KEY
          }
        });
        
        articles = newsResponse.data.articles || [];
        
        if (articles.length > 0) {
          response = "Here are some relevant news stories:\n\n";
          
          articles.forEach((article, index) => {
            response += `${index + 1}. ${article.title}\n`;
            if (article.description) response += `${article.description}\n`;
            response += `Source: ${article.source.name}\n\n`;
          });
          
          response += "Is there anything specific about these stories you'd like to know more about?";
        } else {
          response = "I couldn't find any specific news articles on that topic. Would you like to try a different search term?";
        }
      } catch (error) {
        console.error('News API error:', error.message);
        response = "I'm having trouble retrieving news at the moment. Would you like to chat about something else?";
      }
    } else {
      // General conversation
      if (message.includes('?')) {
        response = "That's an interesting question. While I'm primarily designed to help with news verification, I'd be happy to discuss this topic. What specific aspects are you curious about?";
      } else {
        response = "I'm here to help with news verification and information. Is there a particular news story or topic you'd like to learn about?";
      }
    }
    
    // Store response
    conversations[conversationId].push({ role: 'assistant', content: response });
    
    // Format sources
    const formattedSources = articles.map(article => ({
      title: article.title || 'Untitled',
      source: article.source?.name || 'Unknown Source',
      url: article.url || '#',
      description: article.description || 'No description available',
      publishedAt: article.publishedAt || new Date().toISOString()
    }));
    
    res.json({
      response,
      conversationId,
      sources: formattedSources
    });
    
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ 
      error: true, 
      response: "I'm sorry, there was an error processing your request. Could you try again with a different question?" 
    });
  }
});

// Status endpoint
app.get('/api/status', (req, res) => {
  res.json({ status: 'online', conversationCount: Object.keys(conversations).length });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
🚀 Simple News Chat Server running on port ${PORT}
📝 News API Key: ${process.env.NEWS_API_KEY ? '✅ Present' : '❌ Missing'}
  `);
}); 