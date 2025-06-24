# ExpressJS and TypeScript

## Installation

```
npm i typescript -g
npm i ts-node -g
```

```
git clone https://github.com/naphattharawat/ts-node-db my-api
cd my-api
npm i
```

## Running

```
cp .env.example.txt .env
npm start
```

open browser and go to http://localhost:3000

## PM2

```
npx tsc
pm2 start dist/bin/www.js --name MyServerName
```
