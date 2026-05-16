declare module 'google-search-results-nodejs' {
  class SerpApiSearch {
    constructor(apiKey: string, engine?: string);
    json(params: Record<string, unknown>, callback: (result: Record<string, unknown>) => void): void;
  }

  class GoogleSearch extends SerpApiSearch {
    constructor(apiKey: string);
  }

  export { GoogleSearch, SerpApiSearch };
}
