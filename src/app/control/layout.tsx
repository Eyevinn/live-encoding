type LayoutProps = {
  children: React.ReactNode;
};

export default function ControlLayout({ children }: LayoutProps) {
  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <main className="flex flex-col flex-1 overflow-y-scroll bg-background shadow-inner p-4 lg:p-12 xl:p20">
        <header className="flex flex-col items-center">
          <h1 className="text-xl">Eyevinn Live Encoding</h1>
          <p>Open Source Live Encoder based on ffmpeg</p>
        </header>
        {children}
      </main>
    </div>
  );
}
