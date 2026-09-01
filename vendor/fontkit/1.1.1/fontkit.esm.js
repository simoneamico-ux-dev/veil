import './fontkit.umd.min.js';

if (!globalThis.fontkit) throw new Error('fontkit failed to initialize');

export default globalThis.fontkit;
