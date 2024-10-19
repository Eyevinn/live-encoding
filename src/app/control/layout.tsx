type LayoutProps = {
  children: React.ReactNode;
};

export default function ControlLayout({ children }: LayoutProps) {
  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <header className="flex flex-col items-center mt-8">
        <h1 className="text-4xl">Eyevinn Live Encoding</h1>
        <p>Open Source Live Encoder based on ffmpeg</p>
      </header>
      <main className="flex flex-col flex-1 overflow-y-scroll bg-background shadow-inner">
        {children}
      </main>
    </div>
  );
}
