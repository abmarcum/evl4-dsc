# Stage 1: Build React Frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# Stage 2: Python Backend
FROM python:3.13-slim
WORKDIR /app

# Install uv for dependency management
RUN pip install --no-cache-dir uv

# Copy python project
COPY pyproject.toml ./
COPY main.py ./

# Let uv sync the dependencies into the system or a virtualenv
RUN uv venv && uv pip install -r pyproject.toml
# Wait, uv pip install -r pyproject.toml might not work if it doesn't parse it.
# We will just install the known dependencies directly to be safe.
RUN uv pip install --system fastapi uvicorn websockets pyenvisalink pydantic async-timeout

# Copy config example (actual config mounted via volume)
COPY config.json.example ./config.json

# Copy built frontend assets to static/
RUN mkdir static
COPY --from=frontend-builder /app/frontend/dist/ ./static/

EXPOSE 8000

# Run the app
CMD ["uv", "run", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
