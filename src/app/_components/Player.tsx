import { useEffect, useRef } from 'react';
import webplayer from '@eyevinn/web-player';

import '@eyevinn/web-player/dist/webplayer.css';

export default function Player({
  src,
  autoplay = false
}: {
  src?: string;
  autoplay?: boolean;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (elRef.current && src) {
      const instance = webplayer(elRef.current, {});
      instance.player.load(src, autoplay);
      return () => {
        instance.destroy();
      };
    }
  }, [src]);

  return <div ref={elRef} className="h-full" />;
}
