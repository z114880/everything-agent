/**
 * Conversation Manager - Maintains conversation history and context
 * Used to support multi-turn conversations, record message history and conversation state
 */
export class ConversationManager {
  private messages: Array<{ role: string; content: string; timestamp: Date; messageId: string }>;
  private maxHistoryLength: number;
  private state: {
    conversationId: string;
    startTime: Date;
    messageCount: number;
    lastActivityTime: Date;
  };
  private context: Record<string, unknown>;

  constructor(maxHistoryLength = 10) {
    // Conversation history message list
    this.messages = [];
    // Maximum history length
    this.maxHistoryLength = maxHistoryLength;
    // Conversation state
    this.state = {
      conversationId: this.generateConversationId(),
      startTime: new Date(),
      messageCount: 0,
      lastActivityTime: new Date(),
    };
    // Context information
    this.context = {};
  }

  /**
   * Generate unique conversation ID
   */
  generateConversationId() {
    return `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Add user message
   * @param {string} content User input message content
   */
  addUserMessage(content: string) {
    const message = {
      role: "user",
      content,
      timestamp: new Date(),
      messageId: this.generateMessageId(),
    };
    this.messages.push(message);
    this.updateActivityTime();
    this.state.messageCount++;
    this.trimHistory();
    return message;
  }

  /**
   * Add assistant message
   * @param {string} content Assistant's reply content
   */
  addAssistantMessage(content: string) {
    const message = {
      role: "assistant",
      content,
      timestamp: new Date(),
      messageId: this.generateMessageId(),
    };
    this.messages.push(message);
    this.updateActivityTime();
    return message;
  }

  /**
   * Generate message ID
   */
  generateMessageId() {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get conversation history (for AI models)
   * Returns formatted message list that can be passed directly to LangChain
   */
  getFormattedMessages() {
    return this.messages.map((msg) => ({
      role: msg.role === "user" ? "human" : "assistant",
      content: msg.content,
    }));
  }

  /**
   * Get recent N messages
   * @param {number} count Message count, defaults to 5
   */
  getRecentMessages(count = 5) {
    return this.messages.slice(-count);
  }

  /**
   * Get complete conversation history
   */
  getFullHistory() {
    return {
      conversationId: this.state.conversationId,
      startTime: this.state.startTime,
      messageCount: this.state.messageCount,
      lastActivityTime: this.state.lastActivityTime,
      messages: this.messages,
    };
  }

  /**
   * Clear conversation history
   */
  clearHistory() {
    this.messages = [];
    this.state.conversationId = this.generateConversationId();
    this.state.startTime = new Date();
    this.state.messageCount = 0;
    this.state.lastActivityTime = new Date();
  }

  /**
   * Maintain history length to prevent too many messages
   */
  trimHistory() {
    if (this.messages.length > this.maxHistoryLength) {
      const removed = this.messages.splice(
        0,
        this.messages.length - this.maxHistoryLength
      );
      console.log(
        `[Conversation Manager] Deleted ${removed.length} expired messages, current message count: ${this.messages.length}`
      );
    }
  }

  /**
   * Set context information
   * @param {object} contextData Context data
   */
  setContext(contextData: Record<string, unknown>) {
    this.context = { ...this.context, ...contextData };
  }

  /**
   * Get context information
   */
  getContext() {
    return this.context;
  }

  /**
   * Get conversation summary information (for agent prompt)
   */
  getConversationSummary() {
    return {
      totalMessages: this.state.messageCount,
      lastUserMessage: this.getLastUserMessage(),
      conversationDuration: new Date().getTime() - this.state.startTime.getTime(),
      recentContext: this.getRecentMessages(3),
    };
  }

  /**
   * Get the last user message
   */
  getLastUserMessage() {
    const userMessages = this.messages.filter((msg) => msg.role === "user");
    return userMessages.length > 0 ? userMessages[userMessages.length - 1] : null;
  }

  /**
   * Get the last assistant message
   */
  getLastAssistantMessage() {
    const assistantMessages = this.messages.filter(
      (msg) => msg.role === "assistant"
    );
    return assistantMessages.length > 0
      ? assistantMessages[assistantMessages.length - 1]
      : null;
  }

  /**
   * Update last activity time
   */
  updateActivityTime() {
    this.state.lastActivityTime = new Date();
  }

  /**
   * Export conversation history as JSON
   */
  exportAsJSON() {
    return JSON.stringify(this.getFullHistory(), null, 2);
  }

  /**
   * Check if it's a new conversation (first turn)
   */
  isFirstRound() {
    return this.state.messageCount === 0;
  }

  /**
   * Generate conversation statistics
   */
  getStatistics() {
    const userMessages = this.messages.filter((msg) => msg.role === "user");
    const assistantMessages = this.messages.filter(
      (msg) => msg.role === "assistant"
    );

    return {
      totalMessages: this.messages.length,
      userMessages: userMessages.length,
      assistantMessages: assistantMessages.length,
      averageUserMessageLength:
        userMessages.length > 0
          ? userMessages.reduce((sum, msg) => sum + msg.content.length, 0) /
            userMessages.length
          : 0,
      averageAssistantMessageLength:
        assistantMessages.length > 0
          ? assistantMessages.reduce(
              (sum, msg) => sum + msg.content.length,
              0
            ) / assistantMessages.length
          : 0,
      conversationDurationSeconds: Math.floor(
        (new Date().getTime() - this.state.startTime.getTime()) / 1000
      ),
    };
  }
}
