# Servidor de desarrollo de Vite (recarga en caliente). En AWS: npm run build → S3 + CloudFront.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
EXPOSE 5173
CMD ["npx", "vite", "--host", "0.0.0.0"]
