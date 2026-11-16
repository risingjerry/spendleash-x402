/** SpendLeash mark: a pixel ring (the leash) around one pixel (the agent). */
export function LogoMark({ size = 26 }: { size?: number }) {
  const cells = [
    [0, 0], [1, 0], [2, 0],
    [0, 1], [2, 1],
    [0, 2], [1, 2], [2, 2],
  ];
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 30 30" aria-hidden="true">
      {cells.map(([x, y]) => (
        <rect key={`${x}${y}`} x={x! * 10 + 0.5} y={y! * 10 + 0.5} width="9" height="9" fill="#fff" />
      ))}
      <rect x="12" y="12" width="6" height="6" fill="#e6a7f1" />
    </svg>
  );
}
