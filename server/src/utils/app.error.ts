export class AppError extends Error{
    statusCode : number
    constructor(message : string, statuscode : number = 500) {
        super(message);
        this.name = "AppError"
        this.statusCode = statuscode;
    }
}