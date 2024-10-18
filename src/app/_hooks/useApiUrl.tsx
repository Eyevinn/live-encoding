'use client';

import { useEffect, useState } from 'react';

export function useApiUrl() {
  const [apiUrl, setApiUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    setApiUrl(
      process.env.NEXT_PUBLIC_API_URL || window.location.origin + '/api'
    );
  }, []);
  return apiUrl;
}
