/** Tool schema for the sandboxed write_file tool — declared to providers verbatim (each
 * adapter maps `parameters` into its own wire dialect). No `overwrite` parameter: whether
 * a write overwrites an existing file is computed server-side at approval time and is
 * never the model's decision (see server/src/tools/sandbox.js + routes/toolCalls.js). */
export const WRITE_FILE_TOOL = {
  name: 'write_file',
  description:
    "Write a text file into the user's configured workspace folder. The path MUST be relative to the workspace root; absolute paths and '..' segments are rejected. Every write requires explicit human approval before it happens — propose one file per turn and wait for the result.",
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path within the workspace, e.g. notes/todo.md' },
      content: { type: 'string', description: 'Full UTF-8 text content of the file' },
    },
    required: ['path', 'content'],
  },
};
