/* global module, process, __filename */
const { createRequire } = process.getBuiltinModule('node:module');

module.exports = createRequire(__filename)('./build/Release/fs_ext.node');
