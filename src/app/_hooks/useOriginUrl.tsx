'use client';

import { useEffect, useState } from 'react';
import { useApiUrl } from './useApiUrl';

export function useOriginUrl() {
  const apiUrl = useApiUrl();
  const [originUrl, setOriginUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (apiUrl) {
      setOriginUrl(new URL(apiUrl).origin);
    }
  }, [apiUrl]);
  return originUrl;
}
