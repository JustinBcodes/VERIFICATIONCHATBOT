// Add this function to your frontend JavaScript to properly render markdown links
function renderMarkdown(text) {
  if (!text) return '';
  
  // Convert markdown links [text](url) to HTML links
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  const linkReplaced = text.replace(linkRegex, '<a href="$2" target="_blank" class="text-blue-500 hover:underline">$1</a>');
  
  // Convert markdown bold **text** to HTML bold
  const boldRegex = /\*\*([^*]+)\*\*/g;
  const boldReplaced = linkReplaced.replace(boldRegex, '<strong>$1</strong>');
  
  // Convert markdown italic *text* to HTML italic
  const italicRegex = /\*([^*]+)\*/g;
  const italicReplaced = boldReplaced.replace(italicRegex, '<em>$1</em>');
  
  // Convert newlines to <br> tags
  return italicReplaced.replace(/\n/g, '<br>');
}

// Update your addBotMessage function to use the markdown renderer
function addBotMessage(message, sources = [], confidence = null) {
  removeTypingIndicator();
  
  const chatContainer = document.getElementById('chat-container');
  const messageElement = document.createElement('div');
  messageElement.className = 'p-3 rounded-lg shadow-sm bg-white mb-3 max-w-4xl bot-message';
  
  // Use the markdown renderer for the message
  messageElement.innerHTML = `
    <div class="flex items-start">
      <div class="mr-2 text-xl text-blue-500">
        <i class="ri-robot-line"></i>
      </div>
      <div class="message-content">
        ${renderMarkdown(message)}
      </div>
    </div>
  `;
  
  // Add sources if available
  if (sources && sources.length > 0) {
    const sourcesElement = document.createElement('div');
    sourcesElement.className = 'mt-2 pt-2 border-t border-gray-200 text-sm text-gray-600';
    
    // Create interactive sources list
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