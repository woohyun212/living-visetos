export interface Point {
  x: number;
  y: number;
}

function wrap(value: number, size: number): number {
  return ((value % size) + size) % size;
}

/** 경계에 걸친 모티프를 반대편과 모서리에 복제할 좌표를 계산한다. */
export function getWrappedPositions(
  x: number,
  y: number,
  radius: number,
  tileSize: number,
): Point[] {
  const centerX = wrap(x, tileSize);
  const centerY = wrap(y, tileSize);
  const xs = [centerX];
  const ys = [centerY];

  if (centerX - radius < 0) xs.push(centerX + tileSize);
  if (centerX + radius > tileSize) xs.push(centerX - tileSize);
  if (centerY - radius < 0) ys.push(centerY + tileSize);
  if (centerY + radius > tileSize) ys.push(centerY - tileSize);

  return xs.flatMap((wrappedX) => ys.map((wrappedY) => ({ x: wrappedX, y: wrappedY })));
}

export function drawWrappedMotif(
  x: number,
  y: number,
  radius: number,
  tileSize: number,
  draw: (point: Point) => void,
): void {
  getWrappedPositions(x, y, radius, tileSize).forEach(draw);
}

