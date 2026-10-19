# Imagen para la API y el worker en local. En AWS el mismo código corre como Lambda (npm run build:lambda).
FROM node:22-alpine
# ffmpeg une los segmentos grabados y extrae la copia en audio
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY migrations ./migrations
COPY src ./src
COPY scripts ./scripts
EXPOSE 4000
CMD ["npx", "tsx", "src/entrypoints/server.ts"]
