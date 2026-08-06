FROM node:26-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src

RUN mkdir -p /app/data
USER node

CMD ["npm", "run", "start"]
