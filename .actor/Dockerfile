FROM node:24-bookworm-slim
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci && npx playwright install --with-deps chromium
COPY . ./
RUN npm run build
ENV NODE_ENV=production
CMD ["node", "dist/main.js"]
