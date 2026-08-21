FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV BACKUP_DIR=/data/backups
ENV REPORT_DIR=/data/reports
VOLUME ["/data"]
EXPOSE 3000
CMD ["npm", "start"]
