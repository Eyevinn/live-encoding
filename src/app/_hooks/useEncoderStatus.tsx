'use client';

import { EncoderStatusDTO, getEncoderStatus } from '@/lib/encoderClient';
import { useEffect, useState } from 'react';
import { useApiUrl } from './useApiUrl';

export function useEncoderStatus() {
  const apiUrl = useApiUrl();
  const [status, setStatus] = useState<EncoderStatusDTO | undefined>(undefined);

  function updateStatus() {
    if (!apiUrl) {
      return;
    }
    getEncoderStatus(apiUrl).then(([encoderStatus, error]) => {
      if (error) {
        console.error(error);
        return;
      }
      setStatus(encoderStatus);
    });
  }

  useEffect(() => {
    const interval = setInterval(() => {
      updateStatus();
    }, 1000);

    return () => clearInterval(interval);
  }, [apiUrl]);

  return status;
}
