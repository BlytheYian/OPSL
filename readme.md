cd backend
docker compose up -d db

cd backend
set EDIT_COMMAND_MATCHER=clip
npm run dev

cd frontend
npm run dev