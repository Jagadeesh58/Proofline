import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown } from '../public/markdown.mjs';

test('keeps HTML-looking answer text inert as plain text data', () => {
  const blocks = parseMarkdown('<script>alert(1)</script>');
  assert.equal(blocks[0].type, 'paragraph');
  assert.equal(blocks[0].tokens[0].type, 'text');
  assert.equal(blocks[0].tokens[0].value, '<script>alert(1)</script>');
});

test('does not create links for javascript URLs', () => {
  const blocks = parseMarkdown('javascript:alert(1)');
  assert.deepEqual(blocks[0].tokens, [{ type: 'text', value: 'javascript:alert(1)' }]);
});

test('renders the supported Markdown subset as structured nodes', () => {
  const blocks = parseMarkdown('**Strong** and `code`\n\n- one\n- two\n\n1. first\n2. second\n\n```js\nconst value = 1;\n```');
  assert.equal(blocks[0].tokens[0].type, 'bold');
  assert.ok(blocks[0].tokens.some((token) => token.type === 'code'));
  assert.deepEqual(blocks.filter((block) => block.type === 'ul')[0].items.length, 2);
  assert.deepEqual(blocks.filter((block) => block.type === 'ol')[0].items.length, 2);
  assert.equal(blocks.at(-1).type, 'code-block');
  assert.equal(blocks.at(-1).value, 'const value = 1;');
});
