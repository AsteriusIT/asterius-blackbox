from fastapi import FastAPI

app = FastAPI(title="{{NAME}}")


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.get("/")
def root() -> dict:
    return {"name": "{{NAME}}"}
