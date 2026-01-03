// Centralized error handler
export function errorHandler(err, req, res, next) {
  console.error('Error:', err);

  // Handle known error types
  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: err.message });
  }

  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // Default error response
  res.status(err.status || 500).json({
    error: err.message || 'An unexpected error occurred'
  });
}

// Async handler wrapper to catch errors
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
