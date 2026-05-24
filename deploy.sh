#!/bin/bash

rsync -avz --delete \
  --exclude .git --exclude node_modules --exclude .env \
  ./ randy:~/eah/

ssh randy '
    cd ~/eah &&
    docker compose up -d --build &&
    docker compose exec eah bun scripts/migrate.ts
'
