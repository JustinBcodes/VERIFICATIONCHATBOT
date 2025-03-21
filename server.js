const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// Initialize Express app
const app = express();
app.use(cors());
app.use(express.json());

// Initialize cache with 10-minute TTL
const responseCache = new NodeCache({ stdTTL: 600 });
const conversationCache = new NodeCache({ stdTTL: 3600 }); // 1-hour context retention

// API Configurations
const NEWS_API_BASE_URL = 'https://newsapi.org/v2';
const HUGGINGFACE_API_URL = 'https://api-inference.huggingface.co/models';
const FACTCHECK_SOURCES = ['factcheck.org', 'politifact.com', 'snopes.com', 'reuters.com/fact-check', 'apnews.com/hub/fact-check'];

// Hugging Face model selection
const HF_MODELS = {
  default: 'mistralai/Mistral-7B-Instruct-v0.2',
  large: 'google/flan-t5-xxl',
  small: 'google/flan-t5-large'
};

// Validate environment variables
const requiredEnvVars = ['HUGGINGFACE_API_KEY', 'NEWS_API_KEY'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`⚠️ ${envVar} is missing in .env file`);
    process.exit(1);
  }
}

// Create a rate limiter
const rateLimiter = {
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 20,
  clients: {}
};

// Middleware for rate limiting
function rateLimiterMiddleware(req, res, next) {
  const clientIP = req.ip;
  const now = Date.now();
  
  if (!rateLimiter.clients[clientIP]) {
    rateLimiter.clients[clientIP] = {
      count: 0,
      resetTime: now + rateLimiter.windowMs
    };
  }
  
  const client = rateLimiter.clients[clientIP];
  
  // Reset count if window expired
  if (now > client.resetTime) {
    client.count = 0;
    client.resetTime = now + rateLimiter.windowMs;
  }
  
  // Check if rate limit exceeded
  if (client.count >= rateLimiter.maxRequests) {
    return res.status(429).json({
      error: 'Too many requests',
      message: 'Please try again later'
    });
  }
  
  // Increment count and proceed
  client.count++;
  next();
}

// Apply rate limiting to all routes
app.use(rateLimiterMiddleware);

// Utility function to analyze message intent
function analyzeIntent(message) {
  const normalized = message.toLowerCase().trim();
  
  // Intent patterns
  const patterns = {
    greeting: /^(hi|hello|hey|greetings|howdy|good (morning|afternoon|evening))( there)?!?$/i,
    factCheck: /fact[- ]?check|verify|is (it|this) true|accurate|confirm|debunk|misinformation/i,
    newsQuery: /(news|headline|latest|recent|update|report|story|current events|what('s| is) happening)/i,
    opinionRequest: /what( do)? you think|opinion|stance|perspective|view/i,
    topicQuery: /(tell|inform) me about|what (is|are)|explain|describe|details on/i,
    thankYou: /^(thanks|thank you|thx|ty)!?$/i,
    farewell: /^(bye|goodbye|see you|farewell|later)!?$/i
  };
  
  // Topic categories
  const topics = {
    politics: /politics|election|president|congress|senate|government|biden|trump|democrat|republican/i,
    conflict: /war|conflict|military|attack|invasion|troops|ukraine|russia|israel|palestine|gaza/i,
    technology: /tech|technology|ai|artificial intelligence|apple|google|microsoft|meta|quantum/i,
    economy: /economy|economic|finance|stock|market|inflation|recession|unemployment|fed|federal reserve/i,
    health: /health|covid|pandemic|vaccine|medical|disease|virus|healthcare/i,
    sports: /sports|football|basketball|baseball|soccer|nfl|nba|mlb|tennis|golf/i,
    entertainment: /movie|film|tv|television|show|actor|actress|celebrity|music|album/i
  };
  
  // Determine primary intent
  let primaryIntent = 'general';
  for (const [intent, pattern] of Object.entries(patterns)) {
    if (pattern.test(normalized)) {
      primaryIntent = intent;
      break;
    }
  }
  
  // Identify topics
  const detectedTopics = [];
  for (const [topic, pattern] of Object.entries(topics)) {
    if (pattern.test(normalized)) {
      detectedTopics.push(topic);
    }
  }
  
  return {
    primaryIntent,
    hasQuestion: normalized.includes('?') || /^(what|how|why|when|where|who|is|are|can|could|should|would|do|does|did)/i.test(normalized),
    topics: detectedTopics,
    isNewsRelated: patterns.newsQuery.test(normalized) || detectedTopics.length > 0,
    containsClaim: /claim|said|stated|reported|according to|says|announced/i.test(normalized)
  };
}

// Function to retrieve conversation context
function getConversationContext(conversationId, maxTurns = 5) {
  const conversation = conversationCache.get(conversationId) || { messages: [] };
  // Return just the last few turns to avoid context overflow
  return conversation.messages.slice(-maxTurns * 2);
}

// Function to update conversation context
function updateConversationContext(conversationId, role, content) {
  let conversation = conversationCache.get(conversationId) || { messages: [] };
  conversation.messages.push({ role, content });
  conversationCache.set(conversationId, conversation);
}

// Function to fetch news from multiple sources
async function fetchNewsFromMultipleSources(query, maxResults = 10) {
  // Check cache first
  const cacheKey = `news_${query.toLowerCase().replace(/\s+/g, '_')}`;
  const cachedResults = responseCache.get(cacheKey);
  
  if (cachedResults) {
    console.log('✅ Returning cached news results');
    return cachedResults;
  }
  
  console.log(`🔍 Fetching news for query: "${query}"`);
  
  try {
    // NewsAPI search
    const newsApiPromise = axios.get(`${NEWS_API_BASE_URL}/everything`, {
      params: {
        q: query,
        sortBy: 'relevancy',
        language: 'en',
        pageSize: maxResults,
        apiKey: process.env.NEWS_API_KEY
      }
    }).then(response => response.data.articles)
      .catch(error => {
        console.error('NewsAPI Error:', error.message);
        return [];
      });
      
    // Fetch top headlines as a backup
    const topHeadlinesPromise = axios.get(`${NEWS_API_BASE_URL}/top-headlines`, {
      params: {
        q: query,
        language: 'en',
        pageSize: maxResults / 2,
        apiKey: process.env.NEWS_API_KEY
      }
    }).then(response => response.data.articles)
      .catch(error => {
        console.error('Top Headlines Error:', error.message);
        return [];
      });
      
    // Wait for both to complete
    const [newsApiArticles, topHeadlinesArticles] = await Promise.all([
      newsApiPromise,
      topHeadlinesPromise
    ]);
    
    // Combine results, removing duplicates
    let allArticles = [...newsApiArticles];
    
    // Add top headlines if they're not duplicates
    for (const article of topHeadlinesArticles) {
      if (!allArticles.some(a => a.title === article.title)) {
        allArticles.push(article);
      }
    }
    
    // Filter articles
    const filteredArticles = allArticles
      .filter(article => 
        article && article.title && article.url && article.publishedAt &&
        !article.title.includes('[Removed]')
      )
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
      .slice(0, maxResults);
      
    // Find fact-check specific sources
    const factCheckArticles = filteredArticles.filter(article => 
      article.source && 
      FACTCHECK_SOURCES.some(source => article.url.includes(source))
    );
    
    // Add a tag to fact-check articles
    const taggedArticles = filteredArticles.map(article => ({
      ...article,
      isFactCheck: factCheckArticles.some(fc => fc.url === article.url)
    }));
    
    // Cache the results
    responseCache.set(cacheKey, taggedArticles);
    
    return taggedArticles;
  } catch (error) {
    console.error('Error fetching news:', error);
    return [];
  }
}

// Function to analyze source reliability
function analyzeSourceReliability(source) {
  // High credibility sources
  const highCredibility = [
    'reuters', 'apnews', 'bbc', 'npr', 'pbs', 'washingtonpost', 'nytimes', 
    'wsj', 'economist', 'nature', 'science', 'nationalgeographic'
  ];
  
  // Fact checking sites
  const factCheckers = [
    'factcheck.org', 'politifact', 'snopes', 'fullfact', 'reuters.com/fact-check',
    'apnews.com/hub/fact-check'
  ];
  
  // Check source against lists
  const sourceLower = source.toLowerCase();
  
  if (factCheckers.some(fc => sourceLower.includes(fc))) {
    return { score: 0.95, category: 'fact-checker' };
  }
  
  if (highCredibility.some(hc => sourceLower.includes(hc))) {
    return { score: 0.9, category: 'high-credibility' };
  }
  
  // Default moderate score for unknown sources
  return { score: 0.7, category: 'standard' };
}

// Function to check claim reliability
async function checkClaimReliability(claim, articles) {
  console.log('🔍 Checking claim reliability:', claim);
  
  try {
    // Analyze articles for relevance to the claim
    const relevantArticles = articles.filter(article => {
      // Check title and description for relevance
      const titleMatch = article.title && article.title.toLowerCase().includes(claim.toLowerCase());
      const descMatch = article.description && article.description.toLowerCase().includes(claim.toLowerCase());
      return titleMatch || descMatch;
    });
    
    // Analyze sources from relevant articles
    const sourceAnalysis = relevantArticles.map(article => {
      const source = article.source.name;
      return {
        ...analyzeSourceReliability(source),
        sourceName: source,
        title: article.title,
        url: article.url
      };
    });
    
    // Calculate overall confidence score (weighted by source reliability)
    let confidenceScore = 0;
    let factCheckerSupport = false;
    
    if (sourceAnalysis.length > 0) {
      // Check if any fact-checkers included
      const factCheckers = sourceAnalysis.filter(s => s.category === 'fact-checker');
      factCheckerSupport = factCheckers.length > 0;
      
      // Calculate weighted score
      const totalWeight = sourceAnalysis.reduce((sum, s) => sum + s.score, 0);
      confidenceScore = Math.min(
        Math.round((totalWeight / sourceAnalysis.length) * 100), 
        100
      );
      
      // Boost score if fact-checkers present
      if (factCheckerSupport) {
        confidenceScore = Math.min(confidenceScore + 10, 100);
      }
    } else {
      // No relevant articles found
      confidenceScore = 30; // Low confidence
    }
    
    // Final verification result
    return {
      claim,
      confidenceScore,
      factCheckerSupport,
      sourceAnalysis,
      relevantArticles
    };
  } catch (error) {
    console.error('Error checking claim reliability:', error);
    return {
      claim,
      confidenceScore: 0,
      error: error.message
    };
  }
}

// Function to generate a response using Hugging Face API
async function generateHuggingFaceResponse(prompt, modelType = 'default') {
  try {
    const modelName = HF_MODELS[modelType] || HF_MODELS.default;
    
    // For debugging
    console.log(`🤖 Sending prompt to Hugging Face model: ${modelName}`);
    
    const response = await axios.post(
      `${HUGGINGFACE_API_URL}/${modelName}`,
      { inputs: prompt },
      {
        headers: {
          'Authorization': `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('📤 Hugging Face response:', JSON.stringify(response.data).substring(0, 200) + '...');
    
    // Handle different response formats
    let generatedText = '';
    
    if (Array.isArray(response.data)) {
      generatedText = response.data[0].generated_text || response.data[0];
    } else if (typeof response.data === 'string') {
      generatedText = response.data;
    } else if (response.data && response.data.generated_text) {
      generatedText = response.data.generated_text;
    } else {
      console.log("Unexpected response format:", response.data);
      generatedText = "I'm not sure how to answer that question. Is there something else I can help you with?";
    }
    
    // Clean up the response
    generatedText = generatedText.trim();
    
    // Look for the first response after any "Assistant:" prompt
    const assistantMatch = generatedText.match(/Assistant:(.*?)(?=(Human:|$))/s);
    if (assistantMatch && assistantMatch[1]) {
      generatedText = assistantMatch[1].trim();
    }
    
    return generatedText;
  } catch (error) {
    console.error('❌ Hugging Face API Error:', error.response?.data || error.message);
    
    // Provide a simple, direct fallback response for basic queries
    if (prompt.toLowerCase().includes('hello') || prompt.toLowerCase().includes('hi')) {
      return "Hello! I'm your news verification assistant. How can I help you today?";
    }
    
    return "I apologize, but I'm having trouble generating a response right now. Could you try asking a different question?";
  }
}

// Function to format conversation for Hugging Face context
function formatConversationForHuggingFace(context) {
  return context.map((msg, index) => {
    const prefix = msg.role === 'user' ? 'Human: ' : 'Assistant: ';
    return `${prefix}${msg.content}`;
  }).join('\n\n');
}

// Function to generate AI response
async function generateAIResponse(message, conversationId, articles = [], verificationResults = null) {
  try {
    // Get conversation context
    const context = getConversationContext(conversationId);
    
    // Analyze user intent
    const intent = analyzeIntent(message);
    
    // Determine whether to use a larger model based on complexity
    const isComplexQuery = message.length > 100 || intent.containsClaim || context.length > 6;
    const modelType = isComplexQuery ? 'large' : 'default';
    
    // Format articles information
    let articlesContent = '';
    if (articles && articles.length > 0) {
      articlesContent = 'Relevant articles:\n\n';
      
      articles.slice(0, 5).forEach((article, index) => {
        const date = new Date(article.publishedAt).toLocaleDateString();
        articlesContent += `Article ${index + 1}: "${article.title}"\n`;
        articlesContent += `Source: ${article.source.name} (${date})\n`;
        articlesContent += `Description: ${article.description || 'No description available'}\n\n`;
      });
    }
    
    // Format verification information
    let verificationContent = '';
    if (verificationResults) {
      verificationContent = `Claim verification results:\n\n`;
      verificationContent += `Claim: "${verificationResults.claim}"\n`;
      verificationContent += `Confidence score: ${verificationResults.confidenceScore}%\n`;
      verificationContent += `Fact-checker support: ${verificationResults.factCheckerSupport ? 'Yes' : 'No'}\n\n`;
      
      if (verificationResults.sourceAnalysis && verificationResults.sourceAnalysis.length > 0) {
        verificationContent += 'Source analysis:\n';
        verificationResults.sourceAnalysis.forEach(source => {
          verificationContent += `- ${source.sourceName} (${source.category}, reliability: ${source.score * 100}%)\n`;
        });
      }
    }
    
    // Create system prompt
    let systemPrompt = `You are a helpful, accurate AI assistant specialized in news verification and information.`;
    
    if (intent.isNewsRelated) {
      systemPrompt += `
When discussing news topics:
- Cite your sources clearly
- Present multiple perspectives when relevant
- Prioritize recent, reliable sources
- Flag any claims that seem questionable
- Acknowledge when information might be incomplete
`;
    }

    if (intent.containsClaim) {
      systemPrompt += `
When fact-checking:
- Clearly state the confidence level (0-100%)
- Explain the reasoning behind your verification
- Cite specific sources that support or refute the claim
- Be transparent about limitations in available information
`;
    }
    
    // Format conversation context
    const conversationHistory = formatConversationForHuggingFace(context);
    
    // Build the complete prompt
    let fullPrompt = `${systemPrompt}\n\n`;
    
    if (conversationHistory) {
      fullPrompt += `Conversation history:\n${conversationHistory}\n\n`;
    }
    
    fullPrompt += `Human: ${message}\n\n`;
    
    if (articlesContent) {
      fullPrompt += `${articlesContent}\n`;
    }
    
    if (verificationContent) {
      fullPrompt += `${verificationContent}\n`;
    }
    
    fullPrompt += `Assistant:`;
    
    // Generate response
    console.log(`🤖 Generating response with ${modelType} model for conversation ${conversationId}`);
    
    const response = await generateHuggingFaceResponse(fullPrompt, modelType);
    
    // Update conversation context
    updateConversationContext(conversationId, "user", message);
    updateConversationContext(conversationId, "assistant", response);
    
    return response;
  } catch (error) {
    console.error('Error generating AI response:', error);
    
    // Provide fallback response
    return "I'm having trouble processing your request right now. This might be due to technical limitations or heavy traffic. Could you try again with a different question, or come back a little later?";
  }
}

// Main API endpoint for verification
app.post('/api/verify', async (req, res) => {
  try {
    const { message, conversationId = uuidv4() } = req.body;
    console.log(`📝 Received message: "${message}" for conversation ${conversationId}`);
    
    if (!message) {
      throw new Error('No message provided');
    }
    
    // Handle simple greetings directly without API calls
    if (/^(hello|hi|hey|greetings)$/i.test(message.trim())) {
      const response = "Hello! I'm your news verification assistant. How can I help you today?";
      
      updateConversationContext(conversationId, "user", message);
      updateConversationContext(conversationId, "assistant", response);
      
      return res.json({
        response,
        conversationId,
        sources: []
      });
    }
    
    // For other queries, try to process normally
    const intent = analyzeIntent(message);
    console.log('📊 Message intent:', intent);
    
    // For casual conversation
    if (intent.primaryIntent === 'casual' || intent.primaryIntent === 'greeting') {
      const casualResponses = [
        "I'm doing well, thanks for asking! How can I help you today?",
        "Hello! I'm here to assist with news verification and information. What can I help you with?",
        "Hi there! I'm your news assistant. Do you have a topic you'd like to explore?",
        "Greetings! I'm ready to help you find and verify information. What are you curious about?"
      ];
      
      const response = casualResponses[Math.floor(Math.random() * casualResponses.length)];
      
      updateConversationContext(conversationId, "user", message);
      updateConversationContext(conversationId, "assistant", response);
      
      return res.json({
        response,
        conversationId,
        sources: []
      });
    }
    
    // Try to fetch news for relevant queries
    let articles = [];
    
    if (intent.isNewsRelated) {
      try {
        articles = await fetchNewsFromMultipleSources(message);
      } catch (newsError) {
        console.error('News fetch error:', newsError.message);
        // Continue without news articles
      }
    }
    
    // Generate a basic response if we can't get to the more advanced features
    let response;
    
    try {
      // Try the full response generation
      response = await generateAIResponse(message, conversationId, articles);
    } catch (aiError) {
      console.error('AI response generation error:', aiError.message);
      
      // Fallback to direct model call with simplified prompt
      response = await generateHuggingFaceResponse(
        `The following is a conversation with an AI assistant that helps with news and information.
        
        Human: ${message}
        
        Assistant:`,
        'small'  // Use smaller model for reliability
      );
    }
    
    res.json({
      response,
      conversationId,
      sources: articles.slice(0, 5).map(article => ({
        title: article.title || 'Untitled Article',
        source: article.source?.name || 'Unknown Source',
        url: article.url || '#',
        description: article.description || 'No description available',
        publishedAt: article.publishedAt || new Date().toISOString()
      }))
    });
  } catch (error) {
    console.error('❌ Server Error:', error);
    
    // Send a more helpful error response
    res.status(500).json({ 
      error: true,
      message: error.message,
      response: "I'm currently experiencing technical difficulties. For simple questions, I can still try to help, but complex queries might not work right now."
    });
  }
});

// Endpoint to retrieve conversation history
app.get('/api/conversation/:id', (req, res) => {
  const { id } = req.params;
  const conversation = conversationCache.get(id);
  
  if (!conversation) {
    return res.status(404).json({
      error: 'Conversation not found'
    });
  }
  
  res.json(conversation);
});

// Status check endpoint
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    uptime: process.uptime(),
    apiKeys: {
      huggingface: process.env.HUGGINGFACE_API_KEY ? '✅' : '❌',
      newsApi: process.env.NEWS_API_KEY ? '✅' : '❌'
    },
    models: {
      default: HF_MODELS.default,
      large: HF_MODELS.large,
      small: HF_MODELS.small
    },
    cache: {
      responses: responseCache.getStats(),
      conversations: conversationCache.getStats()
    },
    version: '1.0.0'
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
🚀 News Verification AI Server running on port ${PORT}
📝 API Keys Status:
   Hugging Face API Key: ${process.env.HUGGINGFACE_API_KEY ? '✅ Present' : '❌ Missing'}
   News API Key: ${process.env.NEWS_API_KEY ? '✅ Present' : '❌ Missing'}

🔍 Features Enabled:
   ✅ Context retention (memory)
   ✅ Custom system instructions
   ✅ Structured responses
   ✅ User intent detection
   ✅ Multi-turn conversation
   ✅ Real-time fact-checking
   ✅ Multi-source verification
   ✅ Confidence scoring
  `);
}); 