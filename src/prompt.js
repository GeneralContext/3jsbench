// The request a model is sent for a task: one system prompt shared by every
// task, then the task's brief alone. The prompt text is pinned by hash in
// test/prompt.test.js; changing it changes what every model is asked.
import { createHash } from 'node:crypto';

export const SYSTEM_PROMPT =
  'Write a Three.js 0.184.0 module that builds the object in the brief. Default-export a function that takes ' +
  'no arguments and returns a new THREE.Group. Each call must return a new copy of the same object. Import only ' +
  'from "three", and do not load textures, files or other external resources. Use at most 1,000 meshes and ' +
  '200,000 triangles in total, counting each instance separately. +Y is up, +Z is the front and +X is to the ' +
  'right. Unless the brief says otherwise, the lowest point is at y=0. Add a floor or other scenery only if the ' +
  'brief asks for it. Return only complete raw TypeScript, saved verbatim as asset.ts: no Markdown, explanation ' +
  'or patch.';

export const PROMPT_SHA256 = createHash('sha256').update(SYSTEM_PROMPT).digest('hex');

/** The exact messages for a task from loadTask. */
export function requestMessages(task) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: [{ type: 'text', text: task.prompt }] },
  ];
}
