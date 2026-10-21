import { render } from '@solidjs/web';
import { App } from './App';

render(() => <App />, document.getElementById('app')!);

// 滚动条平时隐藏：正在滚动的元素临时挂 .is-scrolling 让它显示，停下 0.8 秒后收起（触控板/触屏没有 hover 也看得到）
const scrollTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
document.addEventListener('scroll', e => {
  const el = e.target === document ? document.documentElement : (e.target as Element);
  if (!el.classList) return;
  el.classList.add('is-scrolling');
  clearTimeout(scrollTimers.get(el));
  scrollTimers.set(el, setTimeout(() => el.classList.remove('is-scrolling'), 800));
}, true);
