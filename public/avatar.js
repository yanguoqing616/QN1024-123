/**
 * 拟人头像：本地 SVG 生成，不联网、不加载图片
 * 同一个座位永远同一张脸，6 个人长相各不相同
 */

const FACES = [
  { bg: '#f1dfd0', skin: '#f7dcc6', shade: '#ecc9b0', hair: '#332a26', shirt: '#5d7f9c', blush: '#efa49f', style: 0, glass: false },
  { bg: '#dfe7ec', skin: '#f4d3bb', shade: '#e6bfa2', hair: '#4a3527', shirt: '#b4552f', blush: '#e79a92', style: 1, glass: false },
  { bg: '#e8e4d8', skin: '#fbe3ce', shade: '#f0cdb4', hair: '#1f1c1b', shirt: '#5e7a5f', blush: '#eda9a4', style: 2, glass: true },
  { bg: '#f0e2e0', skin: '#f2cfb6', shade: '#e3b89c', hair: '#6b4a32', shirt: '#8a6f9c', blush: '#e59189', style: 3, glass: false },
  { bg: '#e2ece4', skin: '#f9ddc5', shade: '#edc6ab', hair: '#2c2422', shirt: '#b08d4f', blush: '#f0a8a2', style: 1, glass: false },
  { bg: '#e7e3ef', skin: '#efc9ad', shade: '#dcb094', hair: '#3a2f2b', shirt: '#4a7c5d', blush: '#e2968e', style: 2, glass: true }
];

function hair(style, color) {
  const cap = `<path d="M19 29c0-8.4 5.8-13.6 13-13.6S45 20.6 45 29c0 1.4-.5 2-1.3 2-.8-5.6-5.4-8.6-11.7-8.6S21.1 25.4 20.3 31c-.8 0-1.3-.6-1.3-2z" fill="${color}"/>`;
  if (style === 0) return cap;
  if (style === 1) {
    return (
      cap +
      `<path d="M18.4 29.6c-1.7 6-1.4 10.6.5 12.8 1.7 2 3.3-.9 2.2-5.3z" fill="${color}"/>` +
      `<path d="M45.6 29.6c1.7 6 1.4 10.6-.5 12.8-1.7 2-3.3-.9-2.2-5.3z" fill="${color}"/>`
    );
  }
  if (style === 2) {
    return (
      cap +
      `<path d="M30.6 14.8c6.2 0 11.4 3 13.4 8.2-2.4-1.6-5.4-2.2-8.4-1.6-3.8.8-6.8 2.8-9.8 2.8-2.6 0-4.6-.8-6.2-2.2 1.8-4.4 6.2-7.2 11-7.2z" fill="${color}"/>`
    );
  }
  return (
    `<circle cx="32" cy="16.6" r="8.4" fill="${color}"/>` +
    `<path d="M20 29.2c0-7 4.2-11 12-11s12 4 12 11c0 1.1-.5 1.6-1.2 1.6-.8-5-5-7.4-10.8-7.4s-10 2.4-10.8 7.4c-.7 0-1.2-.5-1.2-1.6z" fill="${color}"/>`
  );
}

/**
 * @param {number} seat 座位号（决定长相）
 * @param {number} size 显示尺寸，仅用于 width/height
 */
export function avatarSvg(seat, size = 56) {
  const f = FACES[Math.abs(Number(seat) || 0) % FACES.length];
  const glass = f.glass
    ? `<g fill="none" stroke="#3c3630" stroke-width="1.3" opacity=".8">
         <circle cx="26.5" cy="30.5" r="4.6"/><circle cx="37.5" cy="30.5" r="4.6"/>
         <path d="M31.1 30.5h1.8"/>
       </g>`
    : '';
  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <circle cx="32" cy="32" r="32" fill="${f.bg}"/>
  <path d="M8 64c1.5-10.2 11.2-16.4 24-16.4S54.5 53.8 56 64z" fill="${f.shirt}"/>
  <path d="M26.4 49.4c1.6 2.6 3.4 3.8 5.6 3.8s4-1.2 5.6-3.8" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="1.8" stroke-linecap="round"/>
  <rect x="27.8" y="40" width="8.4" height="10" rx="4.2" fill="${f.shade}"/>
  <ellipse cx="32" cy="30" rx="13" ry="14.4" fill="${f.skin}"/>
  <circle cx="18.6" cy="31.4" r="2.6" fill="${f.skin}"/>
  <circle cx="45.4" cy="31.4" r="2.6" fill="${f.skin}"/>
  ${hair(f.style, f.hair)}
  <ellipse cx="26.6" cy="30.2" rx="1.9" ry="2.4" fill="#2a2622"/>
  <ellipse cx="37.4" cy="30.2" rx="1.9" ry="2.4" fill="#2a2622"/>
  <circle cx="27.3" cy="29.3" r=".8" fill="#fff" opacity=".92"/>
  <circle cx="38.1" cy="29.3" r=".8" fill="#fff" opacity=".92"/>
  <ellipse cx="23.4" cy="35.8" rx="3.3" ry="2" fill="${f.blush}" opacity=".5"/>
  <ellipse cx="40.6" cy="35.8" rx="3.3" ry="2" fill="${f.blush}" opacity=".5"/>
  <path d="M29.4 38.6c1.5 1.7 3.7 1.7 5.2 0" fill="none" stroke="#8d5a4e" stroke-width="1.5" stroke-linecap="round"/>
  ${glass}
</svg>`;
}

/** 带 AI 角标的头像（AI 补位玩家用） */
export function avatarWithBadge(seat, size = 56) {
  return avatarSvg(seat, size);
}
