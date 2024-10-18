'use client';

import { Button } from '@nextui-org/react';
import {
  EncoderStatusDTO,
  startEncoder,
  stopEncoder
} from '@/lib/encoderClient';
import { useApiUrl } from '../_hooks/useApiUrl';
import { useState } from 'react';

export interface EncoderControlProps {
  status?: EncoderStatusDTO;
}

export default function EncoderControl({ status }: EncoderControlProps) {
  const apiUrl = useApiUrl();
  const [isStartLoading, setIsStartLoading] = useState(false);
  const [isStopLoading, setIsStopLoading] = useState(false);

  function handleStart() {
    if (!apiUrl) {
      return;
    }
    setIsStartLoading(true);
    startEncoder(apiUrl)
      .then(([_, error]) => {
        if (error) {
          console.error(error);
        }
      })
      .finally(() => {
        setIsStartLoading(false);
      });
  }

  function handleStop() {
    if (!apiUrl) {
      return;
    }
    setIsStopLoading(true);
    stopEncoder(apiUrl)
      .then(([_, error]) => {
        if (error) {
          console.error(error);
        }
      })
      .finally(() => {
        setIsStopLoading(false);
      });
  }

  return (
    <div>
      {(status?.status === 'idle' ||
        status?.status === 'stopped' ||
        status?.status === 'error') && (
        <Button
          isLoading={isStartLoading}
          color="primary"
          size="lg"
          onPress={() => handleStart()}
        >
          START ENCODER
        </Button>
      )}
      {(status?.status === 'running' || status?.status === 'starting') && (
        <Button
          isLoading={isStopLoading}
          color="danger"
          size="lg"
          onPress={() => handleStop()}
        >
          STOP ENCODER
        </Button>
      )}
    </div>
  );
}
