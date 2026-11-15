process.env.PROOFLINE_SKIP_DOTENV = '1';
if (!process.env.GEMINI_API_KEY) {
  process.env.GEMINI_API_KEY = 'test-stub-gemini-key';
}
if (!process.env.TAVILY_API_KEY) {
  process.env.TAVILY_API_KEY = 'test-stub-tavily-key';
}
if (!process.env.SEARCH_BACKEND) {
  process.env.SEARCH_BACKEND = 'replay';
}
if (!process.env.GEMINI_MODEL) {
  process.env.GEMINI_MODEL = 'gemini-test-stub';
}
if (!process.env.GEMINI_REQUESTS_PER_MINUTE) {
  process.env.GEMINI_REQUESTS_PER_MINUTE = '600';
}
process.env.NODE_ENV = 'test';
