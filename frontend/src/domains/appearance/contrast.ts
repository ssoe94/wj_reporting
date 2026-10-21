/** Text on existing chart/category colors; this does not change their data mapping. */
export function chartLabelColor(background: string): '#000000' | '#ffffff' {
  const hex = background.replace(/^#/, '');
  if (!/^[\da-f]{6}$/i.test(hex)) return '#ffffff';
  const linear = [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#000000' : '#ffffff';
}
