/** Is the wind blowing offshore for a coast facing `coastFacingDeg` (toward the ocean, 0=N)? */
export function isOffshoreWind(windDirection: number, coastFacingDeg: number): boolean {
  const offshoreCenter = (coastFacingDeg + 180) % 360;
  let diff = Math.abs(windDirection - offshoreCenter);
  if (diff > 180) diff = 360 - diff;
  return diff <= 90;
}
