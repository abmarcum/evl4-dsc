#!/bin/bash

# Function to handle cleanup on script exit
cleanup() {
    echo "Stopping servers..."
    kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
    exit 0
}

# Set up trap to call cleanup function on SIGINT (Ctrl+C) or EXIT
trap cleanup SIGINT EXIT

echo "Starting Python FastAPI Backend..."
uv run uvicorn main:app --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!

echo "Starting React Vite Frontend..."
cd frontend && npm run dev --host &
FRONTEND_PID=$!

echo ""
echo "Both servers are running!"
echo "- Backend API: http://localhost:8000"
echo "- Frontend UI: http://localhost:5173"
echo "Press Ctrl+C to stop both servers."
echo ""

# Wait for background processes
wait $BACKEND_PID $FRONTEND_PID
