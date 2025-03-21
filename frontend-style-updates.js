// Add these styles to your CSS or include in your page

// Add this to your head section or CSS file
const styleElement = document.createElement('style');
styleElement.textContent = `
  /* Enhanced message styling */
  .bot-message {
    border-left: 3px solid #3b82f6;
    transition: all 0.3s ease;
    line-height: 1.5;
    font-size: 1rem;
  }
  
  .bot-message:hover {
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  }
  
  .message-content {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
    color: #1f2937;
  }
  
  .message-content a {
    color: #2563eb;
    text-decoration: none;
    border-bottom: 1px solid #dbeafe;
    padding-bottom: 1px;
    transition: border-color 0.2s ease;
  }
  
  .message-content a:hover {
    border-color: #2563eb;
  }
  
  .message-content strong {
    color: #111827;
    font-weight: 600;
  }
  
  /* Better paragraph spacing */
  .message-content p {
    margin-bottom: 0.75rem;
  }
  
  /* Source styling */
  .sources-container {
    margin-top: 12px;
    padding-top: 8px;
    border-top: 1px solid #e5e7eb;
    font-size: 0.875rem;
    color: #6b7280;
  }
  
  .source-item {
    display: flex;
    align-items: center;
    padding: 4px 0;
  }
  
  .source-link {
    display: flex;
    align-items: center;
    color: #3b82f6;
    text-decoration: none;
  }
  
  .source-link:hover {
    text-decoration: underline;
  }
  
  /* Improved typography */
  .bot-message {
    font-feature-settings: "liga" 1, "calt" 1; /* Better typography */
  }
`;
document.head.appendChild(styleElement);

// Enhanced renderMarkdown function for better text formatting
function renderMarkdown(text) {
  if (!text) return '';
  
  // Process the text to improve readability
  let enhancedText = text
    // Add proper spacing after periods if missing
    .replace(/\.(?=[A-Z])/g, '. ')
    // Ensure proper spacing after commas
    .replace(/,(?=[^\s])/g, ', ')
    // Convert markdown links [text](url) to HTML links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    // Convert markdown bold **text** to HTML bold
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // Convert markdown italic *text* to HTML italic
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  
  // Handle paragraphs better by converting line breaks to proper paragraphs
  const paragraphs = enhancedText.split(/\n\s*\n/);
  if (paragraphs.length > 1) {
    enhancedText = paragraphs.map(p => `<p>${p.replace(/\n/g, ' ')}</p>`).join('');
  } else {
    // Convert newlines to <br> tags for single paragraphs
    enhancedText = enhancedText.replace(/\n/g, '<br>');
  }
  
  return enhancedText;
}

// Enhanced addBotMessage function with improved formatting
function addBotMessage(message, sources = []) {
  removeTypingIndicator();
  
  const chatContainer = document.getElementById('chat-container');
  const messageElement = document.createElement('div');
  messageElement.className = 'p-4 rounded-lg shadow-sm bg-white mb-4 max-w-4xl bot-message animate-fadeIn';
  
  // Process message for better formatting
  let processedMessage = message;
  
  // Render the message with enhanced markdown
  messageElement.innerHTML = `
    <div class="flex items-start">
      <div class="mr-3 text-xl text-blue-500 mt-0.5">
        <i class="ri-robot-line"></i>
      </div>
      <div class="message-content flex-1">
        ${renderMarkdown(processedMessage)}
      </div>
    </div>
  `;
  
  // Add sources if available with improved styling
  if (sources && sources.length > 0) {
    const sourcesElement = document.createElement('div');
    sourcesElement.className = 'sources-container';
    
    let sourcesHtml = '<div class="font-semibold mb-2">Sources:</div>';
    sourcesHtml += '<ul class="space-y-1">';
    
    sources.forEach(source => {
      if (source.url && source.title) {
        sourcesHtml += `<li class="source-item">
          <a href="${source.url}" target="_blank" class="source-link">
            <i class="ri-link mr-1"></i> 
            <span>${source.title}</span>
          </a>
          <span class="ml-1 text-xs opacity-75">(${source.source})</span>
        </li>`;
      } else if (source.title) {
        sourcesHtml += `<li class="source-item">
          <span>${source.title}</span>
          <span class="ml-1 text-xs opacity-75">(${source.source})</span>
        </li>`;
      }
    });
    
    sourcesHtml += '</ul>';
    sourcesElement.innerHTML = sourcesHtml;
    messageElement.appendChild(sourcesElement);
  }
  
  // Add subtle entrance animation
  messageElement.style.opacity = '0';
  messageElement.style.transform = 'translateY(10px)';
  
  chatContainer.appendChild(messageElement);
  
  // Trigger animation
  setTimeout(() => {
    messageElement.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    messageElement.style.opacity = '1';
    messageElement.style.transform = 'translateY(0)';
  }, 10);
  
  // Scroll to bottom
  chatContainer.scrollTop = chatContainer.scrollHeight;
} 