// Express 4 does not catch rejected promises from async route handlers. Without
// this wrapper an async route that throws becomes an unhandled rejection, which
// Node 20 treats as fatal — one failed email would take the whole service down
// and leave the request hanging with no response.
module.exports = function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
};
