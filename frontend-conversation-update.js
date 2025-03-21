// Add this to your frontend JavaScript to improve conversation experience

// Track conversation mode
let conversationMode = 'general'; // 'general' or 'news'

// Add event listener for message input to detect potential topics
document.getElementById('message-input').addEventListener('input', function(e) {
  const messageText = e.target.value.toLowerCase();
  
  // Check if message likely contains a news request
  const newsKeywords = ['news', 'latest', 'update', 'recent', 'happening', 'tell me about'];
  const isLikelyNewsRequest = newsKeywords.some(keyword => messageText.includes(keyword));
  
  // Update UI hint if in long-form input and likely a news request
  if (messageText.length > 15 && isLikelyNewsRequest && conversationMode !== 'news') {
    // Optional: Show a subtle hint that the bot can provide news
    // Uncomment if you want to show a hint element
    // document.getElementById('news-hint').style.display = 'block';
  } else {
    // document.getElementById('news-hint').style.display = 'none';
  }
});

// Update the sendMessage function to track conversation mode
function sendMessage() {
  const messageInput = document.getElementById('message-input');
  const message = messageInput.value.trim();
  
  if (message) {
    addUserMessage(message);
    messageInput.value = '';
    showTypingIndicator();
    
    // Send to API
    fetch('/api/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 
        message: message,
        conversationId: currentConversationId 
      }),
    })
    .then(response => response.json())
    .then(data => {
      // Update conversation mode based on response
      if (data.messageType === 'news' || data.sources.length > 0) {
        conversationMode = 'news';
      } else if (['greeting', 'chat', 'question'].includes(data.messageType)) {
        conversationMode = 'general';
      }
      
      addBotMessage(data.response, data.sources);
    })
    .catch(error => {
      console.error('Error:', error);
      addBotMessage("I'm sorry, I encountered an error while processing your request. Please try again.");
    });
  }
}

// Enhanced addBotMessage function with improved formatting
function addBotMessage(message, sources = []) {
  removeTypingIndicator();
  
  const chatContainer = document.getElementById('chat-container');
  const messageElement = document.createElement('div');
  messageElement.className = 'p-3 rounded-lg shadow-sm bg-white mb-3 max-w-4xl bot-message';
  
  // Process message for better formatting
  let processedMessage = message;
  
  // Add natural breaks for longer messages
  if (processedMessage.length > 250) {
    // Add paragraph breaks for readability
    processedMessage = processedMessage.replace(/\.\s+/g, '.\n\n');
  }
  
  // Render the message with markdown
  messageElement.innerHTML = `
    <div class="flex items-start">
      <div class="mr-2 text-xl text-blue-500">
        <i class="ri-robot-line"></i>
      </div>
      <div class="message-content">
        ${renderMarkdown(processedMessage)}
      </div>
    </div>
  `;
  
  // Add sources if available (only for news mode)
  if (sources && sources.length > 0) {
    const sourcesElement = document.createElement('div');
    sourcesElement.className = 'mt-2 pt-2 border-t border-gray-200 text-sm text-gray-600';
    
    let sourcesHtml = '<div class="font-semibold mb-1">Sources:</div>';
    sourcesHtml += '<ul class="space-y-1">';
    
    sources.forEach(source => {
      if (source.url && source.title) {
        sourcesHtml += `<li><a href="${source.url}" target="_blank" class="text-blue-500 hover:underline flex items-center">
          <i class="ri-link mr-1"></i> ${source.title}
          <span class="ml-1 text-xs text-gray-500">(${source.source})</span>
        </a></li>`;
      } else if (source.title) {
        sourcesHtml += `<li>${source.title} <span class="text-xs text-gray-500">(${source.source})</span></li>`;
      }
    });
    
    sourcesHtml += '</ul>';
    sourcesElement.innerHTML = sourcesHtml;
    messageElement.appendChild(sourcesElement);
  }
  
  chatContainer.appendChild(messageElement);
  
  // Scroll to bottom
  chatContainer.scrollTop = chatContainer.scrollHeight;
} 