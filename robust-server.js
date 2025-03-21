const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const { v4: uuidv4 } = require('uuid');
const retry = require('async-retry');
require('dotenv').config();
const schedule = require('node-schedule');
const cheerio = require('cheerio');



const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

// Enhanced cache configuration
const responseCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 }); // Cache OpenAI responses for 1 hour
const newsCache = new NodeCache({ stdTTL: 1800, checkperiod: 120 });     // Cache news articles for 30 minutes
const breakingNewsCache = new NodeCache({ stdTTL: 300 }); // 5 minutes for breaking news

// In-memory conversation storage with size limit
const MAX_HISTORY_LENGTH = 20;
const MAX_CONVERSATIONS = 1000;
const conversations = {};

// API endpoints and models
const NEWS_API_URL = 'https://newsapi.org/v2';
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4-turbo';
const FALLBACK_MODEL = 'gpt-3.5-turbo';

// Improved retry configuration for API calls
const retryOptions = {
  retries: 4,
  factor: 2,
  minTimeout: 1000,
  maxTimeout: 10000,
  randomize: true,
  onRetry: (error, attempt) => {
    console.log(`Retry attempt ${attempt} after error: ${error.message}`);
  }
};

async function callOpenAIWithRetry(messages, model = DEFAULT_MODEL, maxTokens = 500) {
  const recentMessages = messages.slice(-3);
  const cacheKey = `openai:${model}:${JSON.stringify(recentMessages)}`;
  
  const cached = responseCache.get(cacheKey);
  if (cached) {
    console.log('🔄 Using cached OpenAI response');
    return cached;
  }
  
  return retry(async (bail) => {
    try {
      const response = await axios.post(
        OPENAI_API_URL,
        {
          model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.7,
          top_p: 0.9,
          presence_penalty: 0.3,
          frequency_penalty: 0.5
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );
      
      if (response.data?.choices?.[0]?.message?.content) {
        let result = response.data.choices[0].message.content.trim();
        responseCache.set(cacheKey, result);
        return result;
      } else {
        throw new Error('Unexpected response format from OpenAI');
      }
    } catch (error) {
      console.error('OpenAI API error:', error.message);
      if (error.response?.status === 429) {
        console.log('Rate limited by OpenAI, retrying...');
        throw error;
      } else if (error.response?.status === 401) {
        console.error('Authentication error with OpenAI API. Check your API key.');
        bail(new Error('Authentication failed'));
        return 'I apologize, but I am currently experiencing authentication issues with my service.';
      } else if (error.response?.status === 400) {
        console.error('Bad request to OpenAI:', error.response?.data);
        if (error.response?.data?.error?.message?.includes('tokens')) {
          console.log('Context too long, trying with reduced context...');
          const reducedMessages = reduceContextSize(messages);
          if (reducedMessages.length !== messages.length) {
            return callOpenAIWithRetry(reducedMessages, model, maxTokens);
          }
        }
        bail(error);
        return 'I apologize, but I encountered an error processing your request.';
      } else if (error.response?.status >= 500) {
        console.error('OpenAI server error:', error.message);
        throw error;
      } else if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        console.error('Connection timeout to OpenAI:', error.message);
        throw error;
      } else {
        console.error('Unhandled error calling OpenAI:', error);
        if (model !== FALLBACK_MODEL) {
          console.log(`Falling back to ${FALLBACK_MODEL}...`);
          return callOpenAIWithRetry(messages, FALLBACK_MODEL, maxTokens);
        }
        bail(error);
        return 'I apologize, but I am having trouble connecting to my services right now.';
      }
    }
  }, retryOptions);
}

function reduceContextSize(messages) {
  if (messages.length <= 4) return messages;
  const systemMessages = messages.filter(m => m.role === 'system');
  const nonSystemMessages = messages.filter(m => m.role !== 'system');
  const recentMessages = nonSystemMessages.slice(-6);
  return [...systemMessages, ...recentMessages];
}

function calculateStringSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;
  const tokenize = (str) => str.toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, '')
    .split(/\s+/)
    .filter(word => word.length > 2);
  const tokens1 = tokenize(str1);
  const tokens2 = tokenize(str2);
  if (tokens1.length === 0 || tokens2.length === 0) return 0;
  const set1 = new Set(tokens1);
  const set2 = new Set(tokens2);
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  return intersection.size / union.size;
}

function isRepeatingResponse(newResponse, history) {
  const assistantResponses = history.filter(msg => msg.role === 'assistant');
  if (assistantResponses.length < 2) return false;
  const lastResponses = assistantResponses.slice(-3);
  for (let prev of lastResponses) {
    const similarity = calculateStringSimilarity(newResponse, prev.content);
    if (similarity > 0.7) return true;
  }
  const genericPatterns = [
    /I'm here to help/i,
    /How can I assist you/i,
    /Let me know if you need anything else/i,
    /Is there anything else/i
  ];
  let genericCount = 0;
  for (let pattern of genericPatterns) {
    if (pattern.test(newResponse)) genericCount++;
  }
  return genericCount >= 2;
}

async function ensureResponseVariety(response, history, userMessage) {
  if (isRepeatingResponse(response, history)) {
    console.log('Detected repetition; generating a varied response');
    const keywords = extractKeywords(userMessage);
    const topicPrompt = keywords.length > 0 ? `Focus on these topics from the user's message: ${keywords.join(', ')}. ` : '';
    const fallbackMessages = [
      { role: 'system', content: `You are a dynamic conversational assistant. ${topicPrompt}Provide specific, helpful responses that avoid generic phrases. Add a unique insight or perspective if appropriate. Never repeat previous responses or use canned language. Make sure information is 100% accurate and up to date. Also make sure that information is delivered in an aesthetic format for user readability.` },
      { role: 'user', content: userMessage },
      { role: 'system', content: 'IMPORTANT: Your previous response was too similar to earlier messages. Please provide a completely different response that addresses the user\'s query from a fresh angle.' }
    ];
    try {
      const variedResponse = await callOpenAIWithRetry(fallbackMessages, DEFAULT_MODEL);
      return variedResponse;
    } catch (error) {
      console.error('Error generating varied response:', error.message);
      return response;
    }
  }
  return response;
}

function extractKeywords(message) {
  const stopWords = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'and', 'in', 'that', 'have', 'it', 'for', 'on', 'with']);
  return message.toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, '')
    .split(/\s+/)
    .filter(word => word.length > 3 && !stopWords.has(word))
    .slice(0, 5);
}

// Refined intent classification: if the message contains "what's happening" anywhere, treat as news.
function classifyIntent(message) {
  const lowered = message.toLowerCase();
  if (lowered.includes("what's happening") || lowered.includes("what is happening")) {
    return 'news';
  }
  const newsLeadPhrases = /(get|give|tell|show|find|what'?s|any|latest|update me on|brief me on)/i;
  const newsKeywords = /news|headline|article|latest|report|update|breaking|coverage|development|event|story|announcement/i;
  
  if (newsKeywords.test(message) && newsLeadPhrases.test(message)) {
    return 'news';
  }
  
  if (lowered.includes('news about') || lowered.includes('news on')) {
    return 'news';
  }
  
  return 'chat';
}

// Improved topic extraction: remove punctuation and capture the topic after "what's happening..."
function extractNewsTopic(message) {
  const cleanMsg = message.toLowerCase().replace(/[^\w\s]/g, '');
  const match = cleanMsg.match(/what(?:'s| is) happening (?:with|in|on|about)?\s*(.+)/);
  if (match && match[1]) {
    return match[1].trim();
  }
  // Fallback: remove common news-related words and return the rest.
  return cleanMsg.replace(/\b(news|headlines|updates)\b/gi, '').trim();
}

async function fetchNewsArticles(topic, forceRefresh = false) {
  const isBreakingQuery = topic.toLowerCase().includes('breaking') || topic.toLowerCase().includes('latest');
  const cacheKey = getNewsCacheKey(topic, isBreakingQuery);
  
  if (!forceRefresh) {
    if (isBreakingQuery) {
      const breakingCached = breakingNewsCache.get(cacheKey);
      if (breakingCached) {
        console.log('🔥 Using cached breaking news');
        return breakingCached;
      }
    }
    const cached = newsCache.get(cacheKey);
    if (cached) {
      console.log('🔄 Using cached news articles');
      return cached;
    }
  }
  
  return fetchNewsArticlesFromSource(topic, isBreakingQuery);
}

function getNewsCacheKey(topic, isBreaking = false) {
  if (isBreaking) {
    const date = new Date();
    return `breaking:${topic}:${date.toISOString().slice(0,13)}`;
  }
  return `news:${topic.toLowerCase()}`;
}

async function fetchNewsArticlesFromSource(topic, isBreaking = false) {
  let articles = [];
  try {
    // Use the NewsAPI.org "everything" endpoint with proper parameters
    const response = await axios.get(`${NEWS_API_URL}/everything`, {
      params: {
        q: topic,
        language: 'en',
        sortBy: 'publishedAt',
        pageSize: 10,
        apiKey: NEWS_API_KEY
      },
      timeout: 8000
    });
    if (response.data && response.data.articles) {
      articles = response.data.articles.map(article => ({
        title: article.title,
        description: article.description,
        source: article.source ? article.source.id : null,
        publishedAt: article.publishedAt,
        url: article.url
      }));
    }
  } catch (error) {
    console.error('Error fetching news from NewsAPI:', error.message);
    return [];
  }
  
  if (isBreaking) {
    const oneDayAgo = new Date();
    oneDayAgo.setHours(oneDayAgo.getHours() - 24);
    articles = articles.filter(article => {
      const publishDate = new Date(article.publishedAt);
      return publishDate > oneDayAgo;
    });
  }
  
  if (articles.length > 0) {
    if (isBreaking) {
      breakingNewsCache.set(getNewsCacheKey(topic, true), articles);
    } else {
      newsCache.set(getNewsCacheKey(topic, false), articles);
    }
  }
  
  return articles;
}

function enhanceNewsResponse(response, articles) {
  const publishDates = articles
    .map(a => new Date(a.publishedAt))
    .filter(d => !isNaN(d.getTime()));
  
  if (publishDates.length === 0) return response;
  
  const mostRecent = new Date(Math.max(...publishDates));
  const now = new Date();
  const minutesAgo = Math.floor((now - mostRecent) / (1000 * 60));
  const hoursAgo = Math.floor(minutesAgo / 60);
  
  let recencyInfo = '';
  if (minutesAgo < 60) {
    recencyInfo = `[Last updated: ${minutesAgo} minutes ago]`;
  } else if (hoursAgo < 24) {
    recencyInfo = `[Last updated: ${hoursAgo} hours ago]`;
  } else {
    recencyInfo = `[Last updated: ${mostRecent.toLocaleDateString()}]`;
  }
  
  return `${recencyInfo}\n\n${response}`;
}

function detectRealTimeQuery(message) {
  const realTimePatterns = [
    /just happened/i,
    /breaking news/i,
    /happening (right )?now/i,
    /latest development/i,
    /as of now/i,
    /current situation/i,
    /live update/i
  ];
  
  return realTimePatterns.some(pattern => pattern.test(message));
}

async function scrapeRecentNews(topic) {
  try {
    const response = await axios.get('https://news.google.com/search', {
      params: { q: topic },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    const $ = cheerio.load(response.data);
    const articles = [];
    
    $('article').each((i, el) => {
      if (i >= 5) return false;
      
      const title = $(el).find('h3').text();
      const description = $(el).find('.description').text();
      const source = $(el).find('.source').text();
      const time = $(el).find('time').attr('datetime');
      
      articles.push({
        title,
        description,
        source,
        publishedAt: time || new Date().toISOString()
      });
    });
    
    return articles;
  } catch (error) {
    console.error('Error scraping recent news:', error.message);
    return [];
  }
}

async function handleRealTimeNewsQuery(message, topic) {
  let articles = await fetchNewsArticles(topic, true);
  
  if (articles.length === 0) {
    articles = await scrapeRecentNews(topic);
  }
  
  if (articles.length === 0) {
    return `I don't have any real-time updates on "${topic}" at the moment. Would you like me to check for general news on this topic instead?`;
  }
  
  const articlesText = articles.map((article, idx) => {
    const date = article.publishedAt ? new Date(article.publishedAt).toLocaleDateString() + ' ' + new Date(article.publishedAt).toLocaleTimeString() : 'Unknown time';
    return `Article ${idx + 1} (${date}):\nTitle: ${article.title}\nSource: ${article.source || 'Unknown'}\nDescription: ${article.description || 'No description available.'}`;
  }).join('\n\n');

  const prompt = `
You are a real-time news reporter. Based on these ${articles.length} very recent articles about "${topic}", provide a breaking news style update.
Emphasize the timeliness of the information. Focus on what's happening right now.

Articles:
${articlesText}

Important: Format this as a breaking news update with timestamps. Be concise and factual.
Don't reference these instructions or that you're summarizing articles.
`;

  const messagesForNews = [
    { role: 'system', content: 'You are a real-time news reporter.' },
    { role: 'user', content: prompt }
  ];
  
  try {
    const response = await callOpenAIWithRetry(messagesForNews, DEFAULT_MODEL, 700);
    return enhanceNewsResponse(response, articles);
  } catch (error) {
    console.error('Error generating real-time news:', error.message);
    return `I found ${articles.length} recent updates about "${topic}", but I'm having trouble summarizing them right now.`;
  }
}

async function handleNewsQuery(message) {
  const topic = extractNewsTopic(message);
  let articles = await fetchNewsArticles(topic);
  if (articles.length === 0) {
    articles = await scrapeRecentNews(topic);
  }
  
  if (articles.length === 0) {
    return `I couldn't find any recent news on "${topic}". Maybe try asking something else?`;
  }
  
  const articlesText = articles.map((article, idx) => {
    const date = article.publishedAt ? new Date(article.publishedAt).toLocaleString() : 'Unknown time';
    return `Article ${idx + 1} (at ${date}): "${article.title}" - ${article.description || 'No description available.'}`;
  }).join('\n\n');
  
  const prompt = `
You are a news assistant who is extremely conversational and friendly. The user asked for news on "${topic}". Here are some articles:
${articlesText}

Now, provide a conversational summary of the news, mentioning key highlights and details, as if you're chatting with a friend. Keep it casual and engaging.
  `;
  
  const messagesForNews = [
    { role: 'system', content: 'You are an extremely conversational and friendly news assistant.' },
    { role: 'user', content: prompt }
  ];
  
  try {
    const response = await callOpenAIWithRetry(messagesForNews, DEFAULT_MODEL, 700);
    return enhanceNewsResponse(response, articles);
  } catch (error) {
    console.error('Error generating news summary:', error.message);
    return `I found ${articles.length} articles on "${topic}", but I'm having trouble summarizing them right now.`;
  }
}

async function handleChatConversation(message, history = []) {
  // Check for chat-based news queries like "what's new on ..."
  const newsQueryMatch = message.match(/what'?s new on (.+)/i);
  if (newsQueryMatch) {
    const topic = newsQueryMatch[1].trim();
    return await handleNewsQuery(topic);
  }
  
  const systemMessage = {
    role: 'system',
    content: `You are an extremely conversational and engaging chatbot. Chat naturally like a friendly companion who is both knowledgeable and relatable. Feel free to engage in small talk, ask clarifying questions, and use a casual tone. If the user asks about news, integrate the latest updates in a conversational manner. If you don't know something, be honest about it.`
  };
  
  let effectiveHistory = history;
  if (history.length > MAX_HISTORY_LENGTH) {
    const systemMessages = history.filter(msg => msg.role === 'system');
    const recentHistory = history.filter(msg => msg.role !== 'system').slice(-MAX_HISTORY_LENGTH);
    effectiveHistory = [...systemMessages, ...recentHistory];
  }
  
  const messages = [systemMessage, ...effectiveHistory, { role: 'user', content: message }];
  
  try {
    const isComplexQuery = message.length > 100 || message.includes('?') || /explain|describe|how|why/i.test(message);
    const maxTokens = isComplexQuery ? 700 : 400;
    
    const response = await callOpenAIWithRetry(messages, DEFAULT_MODEL, maxTokens);
    return response;
  } catch (error) {
    console.error('Error in chat conversation:', error.message);
    if (history.length > 2) {
      try {
        console.log('Retrying with reduced context...');
        const reducedHistory = history.slice(-2);
        const reducedMessages = [systemMessage, ...reducedHistory, { role: 'user', content: message }];
        return await callOpenAIWithRetry(reducedMessages, DEFAULT_MODEL);
      } catch (innerError) {
        console.error('Error even with reduced context:', innerError.message);
      }
    }
    return "I apologize, but I'm having difficulty processing our conversation right now. Could you please try again with your question?";
  }
}

app.use((req, res, next) => {
  if (req.path === '/api/status') {
    return next();
  }
  
  const missingKeys = [];
  if (!process.env.OPENAI_API_KEY) missingKeys.push('OpenAI API Key');
  if (!process.env.NEWS_API_KEY) missingKeys.push('News API Key');
  
  if (missingKeys.length > 0) {
    console.error(`Missing required API keys: ${missingKeys.join(', ')}`);
    return res.status(503).json({
      error: `Missing required API keys: ${missingKeys.join(', ')}`,
      response: "The service is currently unavailable due to missing configuration. Please check the server logs."
    });
  }
  
  next();
});

function manageConversations() {
  const conversationIds = Object.keys(conversations);
  if (conversationIds.length > MAX_CONVERSATIONS) {
    console.log(`Pruning conversation store (${conversationIds.length} > ${MAX_CONVERSATIONS})`);
    const sorted = conversationIds
      .map(id => ({ 
        id, 
        lastActive: conversations[id].length > 0 ? new Date(conversations[id][conversations[id].length - 1].timestamp || 0) : new Date(0)
      }))
      .sort((a, b) => a.lastActive - b.lastActive);
    
    const toRemove = sorted.slice(0, sorted.length - MAX_CONVERSATIONS).map(item => item.id);
    for (const id of toRemove) {
      delete conversations[id];
    }
    console.log(`Removed ${toRemove.length} old conversations`);
  }
}

function setupNewsPolling() {
  schedule.scheduleJob('*/15 * * * *', async function() {
    console.log('🔄 Polling for breaking news updates');
    const hotTopics = ['world', 'politics', 'technology', 'business', 'health'];
    
    for (const topic of hotTopics) {
      try {
        await refreshBreakingNews(topic);
      } catch (error) {
        console.error(`Error polling news for ${topic}:`, error.message);
      }
    }
  });
}

async function refreshBreakingNews(topic) {
  const cacheKey = getNewsCacheKey(topic, true);
  const articles = await fetchNewsArticlesFromSource(topic, true);
  if (articles.length > 0) {
    breakingNewsCache.set(cacheKey, articles);
    console.log(`Updated breaking news for "${topic}": ${articles.length} articles`);
  }
}

app.post('/api/verify', async (req, res) => {
  try {
    const { message, conversationId = uuidv4() } = req.body;
    
    if (!message || typeof message !== 'string') {
      return res.status(400).json({
        error: 'Invalid or missing message',
        response: 'Please provide a valid message.'
      });
    }
    
    console.log(`📝 Received message: "${message.substring(0, 50)}${message.length > 50 ? '...' : ''}" (Conversation: ${conversationId})`);

    if (!conversations[conversationId]) {
      conversations[conversationId] = [];
    }
    
    const history = conversations[conversationId];
    const timestamp = new Date().toISOString();
    
    const intent = classifyIntent(message);
    let response = '';

    if (intent === 'news') {
      const isRealTimeQuery = detectRealTimeQuery(message);
      const topic = extractNewsTopic(message);
      
      if (isRealTimeQuery) {
        console.log(`📰 Fetching REAL-TIME news about: "${topic}"`);
        response = await handleRealTimeNewsQuery(message, topic);
      } else {
        response = await handleNewsQuery(message);
      }
    } else {
      response = await handleChatConversation(message, history);
    }

    response = await ensureResponseVariety(response, history, message);

    history.push({ role: 'user', content: message, timestamp });
    history.push({ role: 'assistant', content: response, timestamp: new Date().toISOString() });
    
    manageConversations();

    res.json({
      response,
      conversationId,
      messageType: intent,
      timestamp
    });
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({
      response: "I apologize for the inconvenience. My system is experiencing temporary difficulties. Please try again in a moment.",
      conversationId: req.body.conversationId || uuidv4(),
      error: { message: 'Internal server error', code: 'INTERNAL_ERROR' }
    });
  }
});

app.get('/api/conversation/:id', (req, res) => {
  const { id } = req.params;
  if (!conversations[id]) {
    return res.status(404).json({ 
      error: 'Conversation not found',
      message: 'No conversation found with the provided ID.'
    });
  }
  
  const formattedHistory = conversations[id].map(({ role, content, timestamp }) => ({
    role,
    content,
    timestamp: timestamp || new Date().toISOString()
  }));
  
  res.json({
    id,
    messages: formattedHistory,
    messageCount: formattedHistory.length
  });
});

app.get('/api/status', (req, res) => {
  const now = Date.now();
  const hourAgo = now - (60 * 60 * 1000);
  const activeConversations = Object.values(conversations).filter(msgs => {
    const lastMsg = msgs[msgs.length - 1];
    return lastMsg && new Date(lastMsg.timestamp || 0).getTime() > hourAgo;
  }).length;
  
  res.json({
    status: 'online',
    uptime: process.uptime().toFixed(2) + ' seconds',
    apiStatus: {
      openai: process.env.OPENAI_API_KEY ? '✅ Connected' : '❌ Missing key',
      newsapi: process.env.NEWS_API_KEY ? '✅ Connected' : '❌ Missing key'
    },
    models: {
      primary: DEFAULT_MODEL,
      fallback: FALLBACK_MODEL
    },
    memory: {
      rss: (process.memoryUsage().rss / 1024 / 1024).toFixed(2) + ' MB',
      heapTotal: (process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2) + ' MB',
      heapUsed: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2) + ' MB'
    },
    cache: {
      responses: {
        keys: responseCache.keys().length,
        hits: responseCache.getStats().hits,
        misses: responseCache.getStats().misses,
        ksize: responseCache.getStats().ksize,
        vsize: responseCache.getStats().vsize
      },
      news: {
        keys: newsCache.keys().length,
        hits: newsCache.getStats().hits,
        misses: newsCache.getStats().misses
      }
    },
    conversations: {
      total: Object.keys(conversations).length,
      active: activeConversations
    },
    timestamp: new Date().toISOString()
  });
});

app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: 'The server encountered an unexpected condition that prevented it from fulfilling the request.'
  });
});

setInterval(() => {
  try {
    const now = Date.now();
    const dayAgo = now - (24 * 60 * 60 * 1000);
    let removedCount = 0;
    
    for (const [id, msgs] of Object.entries(conversations)) {
      if (msgs.length === 0 || 
         (msgs[msgs.length - 1].timestamp && new Date(msgs[msgs.length - 1].timestamp).getTime() < dayAgo)) {
        delete conversations[id];
        removedCount++;
      }
    }
    
    if (removedCount > 0) {
      console.log(`🧹 Cleaned up ${removedCount} inactive conversations`);
    }
  } catch (error) {
    console.error('Error during conversation cleanup:', error);
  }
}, 3600000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
🚀 Enhanced Chat & News Assistant Server running on port ${PORT}
📝 API Keys:
   OpenAI API Key: ${process.env.OPENAI_API_KEY ? '✅ Present' : '❌ Missing'}
   News API Key: ${process.env.NEWS_API_KEY ? '✅ Present' : '❌ Missing'}
🔧 Configuration:
   Primary Model: ${DEFAULT_MODEL}
   Fallback Model: ${FALLBACK_MODEL}
   Conversation Limit: ${MAX_CONVERSATIONS}
   History Limit: ${MAX_HISTORY_LENGTH} messages
  `);
  
  setupNewsPolling();
});
