export function Crest({ className = 'w-10 h-10' }: { className?: string }) {
  return (
    <img
      src="/acapomil-logo.png"
      alt="ACAPOMIL"
      className={`${className} object-contain rounded-md bg-transparent`}
      draggable={false}
    />
  );
}
