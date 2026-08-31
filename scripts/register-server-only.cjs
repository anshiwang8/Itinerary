// Plain Node unit suites execute server code without Next's compiler, which
// normally replaces this marker with its empty server implementation. Scope
// that same replacement to the test process; never preload this in the app.
// Avoid --conditions=react-server: component tests need normal React exports.
const marker = require.resolve("server-only");
require.cache[marker] = {
  id: marker,
  filename: marker,
  loaded: true,
  exports: {},
};
