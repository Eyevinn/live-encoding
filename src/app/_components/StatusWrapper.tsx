'use client';

import { useEncoderStatus } from '../_hooks/useEncoderStatus';
import { useOriginUrl } from '../_hooks/useOriginUrl';
import EncoderControl from './EncoderControl';
import EncoderStatus from './EncoderStatus';
import Player from './Player';

export default function StatusWrapper() {
  const status = useEncoderStatus();
  const originUrl = useOriginUrl();

  return (
    <>
      <div className="flex flex-col h-full items-center justify-center gap-4">
        {status?.playlist && status?.status === 'running' && (
          <div className="w-3/4">
            <Player src={originUrl + status.playlist} autoplay={true} />
          </div>
        )}
        <EncoderControl status={status} />
      </div>
      <div className="w-full h-32px bg-content1 flex items-center z-20 fixed bottom-0">
        <EncoderStatus
          status={status}
          originPlaybackUrl={
            status?.status === 'running' && originUrl
              ? originUrl + status.playlist
              : undefined
          }
        />
      </div>
    </>
  );
}
