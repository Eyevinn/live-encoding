'use client';

import { EncoderStatusDTO } from '@/lib/encoderClient';
import { useApiUrl } from '../_hooks/useApiUrl';

export interface EncoderStatusProps {
  status?: EncoderStatusDTO;
  originPlaybackUrl?: string;
}

export default function EncoderStatus({
  status,
  originPlaybackUrl
}: EncoderStatusProps) {
  const apiUrl = useApiUrl();

  return (
    <span className="text-xs ml-2">
      {apiUrl}: {status?.status} {originPlaybackUrl}
    </span>
  );
}
