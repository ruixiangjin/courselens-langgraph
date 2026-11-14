FROM node:24-bookworm-slim
RUN npm install -g pnpm@12.5.1
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
USER node
EXPOSE 8080
CMD ["node", "--import", "tsx", "scripts/courselens-server.ts"]
