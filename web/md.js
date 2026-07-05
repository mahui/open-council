// Markdown 渲染 + 净化。LLM 输出可能含 <img onerror> 等注入，
// 一律先 marked 解析再 DOMPurify 净化 —— XSS 是硬红线（SEC）。
import { marked } from './vendor/marked.esm.js';
import DOMPurify from './vendor/purify.es.js';

marked.setOptions({ gfm: true, breaks: true });

// 净化后为外链补 rel/target，避免 tabnabbing；不允许任何内联事件属性。
// addHook 仅在有 DOM 的环境（浏览器）存在；无 DOM 环境（如 Node 冒烟测试）跳过。
if (typeof DOMPurify.addHook === 'function') {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.getAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
  });
}

const ALLOWED = {
  ALLOWED_TAGS: [
    'p', 'br', 'hr', 'strong', 'em', 'del', 'blockquote',
    'ul', 'ol', 'li', 'code', 'pre', 'span',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ],
  ALLOWED_ATTR: ['href', 'title', 'class', 'align'],
  ALLOW_DATA_ATTR: false,
};

/** Markdown 字符串 → 净化后的安全 HTML。空输入返回空串。 */
export function renderMarkdown(src) {
  if (!src) return '';
  const raw = marked.parse(String(src));
  return DOMPurify.sanitize(raw, ALLOWED);
}

/** 纯文本转义（用于非 markdown 场景，如问题预览）。 */
export function escapeText(src) {
  if (!src) return '';
  return DOMPurify.sanitize(String(src), { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
}
