import { render } from 'preact';
import { App } from './app.tsx';

const root = document.getElementById('app');
if (!root) throw new Error('No #app element to render the editor in.');
render(<App />, root);
