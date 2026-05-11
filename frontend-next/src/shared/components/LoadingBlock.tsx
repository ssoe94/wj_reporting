type LoadingBlockProps = {
  label: string;
};

export function LoadingBlock({ label }: LoadingBlockProps) {
  return <div className="notice notice--neutral">{label}</div>;
}
