// Type definitions
export interface HttpClientConfig {
  baseURL?: string;
  timeout?: number;
  headers?: Record<string, string>;
}

export interface RequestConfig extends Omit<RequestInit, 'body'> {
  timeout?: number;
  params?: Record<string, string | number | boolean>;
  data?: unknown;
}

export interface HttpResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Headers;
}

export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
    public response?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

// Environment detection
const isNode = typeof window === 'undefined' && typeof global !== 'undefined';

class HttpClient {
  private config: HttpClientConfig;

  constructor(config: HttpClientConfig = {}) {
    this.config = {
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
      ...config,
    };
  }

  private buildURL(
    url: string,
    params?: Record<string, string | number | boolean>,
  ): string {
    const baseURL = this.config.baseURL || '';
    const fullURL = url.startsWith('http') ? url : `${baseURL}${url}`;

    if (!params) return fullURL;

    const urlObj = new URL(fullURL);
    for (const [key, value] of Object.entries(params)) {
      urlObj.searchParams.set(key, String(value));
    }

    return urlObj.toString();
  }

  private async makeRequest<T>(
    method: string,
    url: string,
    config: RequestConfig = {},
  ): Promise<HttpResponse<T>> {
    const {
      timeout = this.config.timeout,
      params,
      data,
      headers,
      ...restConfig
    } = config;
    const fullURL = this.buildURL(url, params);

    const requestHeaders: Record<string, string> = {
      ...this.config.headers,
    };

    // Merge additional headers
    if (headers) {
      Object.assign(requestHeaders, headers);
    }

    let requestBody: string | FormData | undefined;
    let undiciBody: string | Buffer | undefined;

    if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      if (typeof data === 'object' && !(data instanceof FormData)) {
        requestBody = JSON.stringify(data);
        undiciBody = JSON.stringify(data);
      } else if (data instanceof FormData) {
        requestBody = data;
        // Convert FormData to string for Undici
        const formDataEntries: string[] = [];
        for (const [key, value] of data.entries()) {
          formDataEntries.push(
            `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
          );
        }
        undiciBody = formDataEntries.join('&');
        // Update content-type for form data when using Undici
        if (isNode) {
          requestHeaders['content-type'] = 'application/x-www-form-urlencoded';
        }
      } else {
        requestBody = String(data);
        undiciBody = String(data);
      }
    }

    const requestConfig: RequestInit = {
      method,
      headers: requestHeaders,
      body: requestBody,
      ...restConfig,
    };

    try {
      let response: Response;

      if (isNode) {
        // Use Undici for Node.js environment
        const { request } = await import('undici');
        const undiciResponse = await request(fullURL, {
          method,
          headers: requestHeaders,
          body: undiciBody,
          headersTimeout: timeout,
          bodyTimeout: timeout,
        });

        // Convert Undici response to standard Response-like object
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(undiciResponse.headers)) {
          if (Array.isArray(value)) {
            for (const v of value) {
              responseHeaders.append(key, v);
            }
          } else if (value) {
            responseHeaders.set(key, String(value));
          }
        }

        const body = await undiciResponse.body.text();

        response = {
          ok:
            undiciResponse.statusCode >= 200 && undiciResponse.statusCode < 300,
          status: undiciResponse.statusCode,
          statusText: '',
          headers: responseHeaders,
          text: async () => body,
          json: async () => JSON.parse(body),
        } as Response;
      } else {
        // Use fetch for browser environment
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        try {
          response = await fetch(fullURL, {
            ...requestConfig,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new HttpError(
          `HTTP Error: ${response.status} ${response.statusText}`,
          response.status,
          errorText,
        );
      }

      const contentType = response.headers.get('content-type');
      let responseData: T;

      if (contentType?.includes('application/json')) {
        responseData = await response.json();
      } else {
        responseData = (await response.text()) as unknown as T;
      }

      return {
        data: responseData,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      };
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new HttpError('Request timeout', 408);
        }
        throw new HttpError(`Network Error: ${error.message}`, 0);
      }

      throw new HttpError('Unknown error occurred', 0);
    }
  }

  // HTTP Methods with TypeScript generics
  async get<T = unknown>(
    url: string,
    config?: Omit<RequestConfig, 'data'>,
  ): Promise<HttpResponse<T>> {
    return this.makeRequest<T>('GET', url, config);
  }

  async post<T = unknown>(
    url: string,
    data?: unknown,
    config?: RequestConfig,
  ): Promise<HttpResponse<T>> {
    return this.makeRequest<T>('POST', url, { ...config, data });
  }

  async put<T = unknown>(
    url: string,
    data?: unknown,
    config?: RequestConfig,
  ): Promise<HttpResponse<T>> {
    return this.makeRequest<T>('PUT', url, { ...config, data });
  }

  async patch<T = unknown>(
    url: string,
    data?: unknown,
    config?: RequestConfig,
  ): Promise<HttpResponse<T>> {
    return this.makeRequest<T>('PATCH', url, { ...config, data });
  }

  async delete<T = unknown>(
    url: string,
    config?: Omit<RequestConfig, 'data'>,
  ): Promise<HttpResponse<T>> {
    return this.makeRequest<T>('DELETE', url, config);
  }

  async head<T = unknown>(
    url: string,
    config?: Omit<RequestConfig, 'data'>,
  ): Promise<HttpResponse<T>> {
    return this.makeRequest<T>('HEAD', url, config);
  }

  async options<T = unknown>(
    url: string,
    config?: Omit<RequestConfig, 'data'>,
  ): Promise<HttpResponse<T>> {
    return this.makeRequest<T>('OPTIONS', url, config);
  }

  // Utility methods
  setBaseURL(baseURL: string): void {
    this.config.baseURL = baseURL;
  }

  setDefaultHeaders(headers: Record<string, string>): void {
    this.config.headers = { ...this.config.headers, ...headers };
  }

  setTimeout(timeout: number): void {
    this.config.timeout = timeout;
  }
}

// Create default instance
export const http = new HttpClient({
  baseURL: import.meta.env.VITE_API_BASE_URL,
});

// Export the class for custom instances
export { HttpClient };
