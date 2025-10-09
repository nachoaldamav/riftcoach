// IndexedDB cache for Data Dragon data
interface CacheItem<T> {
  data: T;
  timestamp: number;
  version?: string;
}

class DataDragonCache {
  private dbName = 'riftcoach-data-dragon';
  private dbVersion = 1;
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        
        // Create object stores
        if (!db.objectStoreNames.contains('versions')) {
          db.createObjectStore('versions', { keyPath: 'key' });
        }
        
        if (!db.objectStoreNames.contains('champions')) {
          db.createObjectStore('champions', { keyPath: 'key' });
        }
      };
    });
  }

  async get<T>(storeName: string, key: string): Promise<T | null> {
    if (!this.db) await this.init();
    
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }
      
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const result = request.result as CacheItem<T> | undefined;
        if (!result) {
          resolve(null);
          return;
        }

        // Check if data is still valid (24 hours)
        const isExpired = Date.now() - result.timestamp > 24 * 60 * 60 * 1000;
        if (isExpired) {
          this.delete(storeName, key); // Clean up expired data
          resolve(null);
          return;
        }

        resolve(result.data);
      };
    });
  }

  async set<T>(storeName: string, key: string, data: T, version?: string): Promise<void> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }
      
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      
      const cacheItem: CacheItem<T> & { key: string } = {
        key,
        data,
        timestamp: Date.now(),
        version,
      };

      const request = store.put(cacheItem);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async delete(storeName: string, key: string): Promise<void> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }
      
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.delete(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async clear(storeName: string): Promise<void> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }
      
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.clear();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  // Clean up old champion data when version changes
  async cleanupOldVersions(currentVersion: string): Promise<void> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }
      
      const transaction = this.db.transaction(['champions'], 'readwrite');
      const store = transaction.objectStore('champions');
      const request = store.getAll();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const items = request.result as (CacheItem<unknown> & { key: string })[];
        const deletePromises = items
          .filter(item => item.version && item.version !== currentVersion)
          .map(item => this.delete('champions', item.key));

        Promise.all(deletePromises).then(() => resolve()).catch(reject);
      };
    });
  }
}

// Export singleton instance
export const dataDragonCache = new DataDragonCache();